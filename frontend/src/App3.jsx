import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Disconnected");
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [pdfContextDebug, setPdfContextDebug] = useState(""); // Debug: show chunk text

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);

  // ephemeral key for GPT
  const ephemeralKeyRef = useRef("");
  // conversation ID if needed
  const conversationIdRef = useRef("");

  useEffect(() => {
    const saved = localStorage.getItem("chatHistory");
    if (saved) {
      setMessages(JSON.parse(saved));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("chatHistory", JSON.stringify(messages));
  }, [messages]);

  // 1) Start Session
  const initWebRTC = async () => {
    try {
      // console log for debugging
      console.log("Requesting session from backend...");
      const resp = await fetch("http://localhost:8000/session");
      const sessionData = await resp.json();
      console.log("Session data:", sessionData);

      ephemeralKeyRef.current = sessionData.client_secret.value;
      conversationIdRef.current = "";

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio
      const remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      audioRef.current = remoteAudio;
      pc.ontrack = (e) => {
        console.log("Received remote track event:", e.streams);
        if (e.streams[0]) remoteAudio.srcObject = e.streams[0];
      };

      // Local microphone
      console.log("Requesting local mic...");
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      console.log("Local mic acquired:", localStream);

      localStream.getTracks().forEach(track => {
        console.log("Adding track to RTCPeerConnection:", track);
        pc.addTrack(track, localStream);
      });

      // Data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onmessage = async (evt) => {
        const eventData = JSON.parse(evt.data);
        console.log("Data channel onmessage:", eventData);

        switch (eventData.type) {
          case 'conversation.created':
            console.log("Conversation created:", eventData.conversation);
            conversationIdRef.current = eventData.conversation.id;
            break;

          case 'conversation.item.created':
            // If role=user => user just spoke, we have a transcript
            if (eventData.item.role === 'user' && eventData.item.content[0]?.transcript) {
              console.log("User audio transcript committed:", eventData.item.content[0].transcript);
              const userTranscript = eventData.item.content[0].transcript;

              // Update chat
              setMessages(prev => [...prev, { sender: "You", text: userTranscript }]);

              // PDF chunk retrieval
              const context = await fetchPdfChunks(userTranscript);
              // Now create a new AI response
              createResponseEvent(userTranscript, context);
            }
            break;

          case 'response.audio_transcript.delta':
            console.log("AI partial transcript delta:", eventData.delta);
            break;

          case 'response.audio_transcript.done':
            console.log("AI final transcript:", eventData.transcript);
            setMessages(prev => [...prev, { sender: "AI", text: eventData.transcript }]);
            break;

          case 'input_audio_buffer.speech_started':
            console.log("Speech started event =>", eventData);
            setStatusMessage("Listening...");
            break;

          case 'input_audio_buffer.speech_stopped':
            console.log("Speech stopped event =>", eventData);
            // We expect a conversation.item.created soon after
            break;

          case 'response.created':
            console.log("Response created by server => AI is speaking");
            setStatusMessage("AI is speaking...");
            break;

          case 'response.audio.done':
            console.log("AI's audio is done streaming");
            setStatusMessage("Connected");
            break;

          default:
            // console.log("Other event:", eventData.type);
            break;
        }
      };

      // Create SDP offer
      console.log("Creating SDP offer...");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Post to Realtime
      console.log("Sending offer to GPT Realtime...");
      const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${sessionData.client_secret.value}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      });

      const answerSdp = await sdpResp.text();
      console.log("Received answer from GPT, setting remote desc...");
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setIsConnected(true);
      setStatusMessage("Connected");
      console.log("WebRTC connected successfully.");
    } catch (err) {
      console.error("initWebRTC error:", err);
      setStatusMessage("Error initializing WebRTC");
    }
  };

  // 2) End session
  const endSession = () => {
    console.log("Ending session...");
    pcRef.current?.close();
    pcRef.current = null;
    setIsConnected(false);
    setStatusMessage("Disconnected");
    setMessages([]);
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
  };

  // PDF chunk retrieval
  const fetchPdfChunks = async (query) => {
    console.log("Calling /chunks with query:", query);
    try {
      const r = await fetch(`http://localhost:8000/chunks?q=${encodeURIComponent(query)}`);
      const j = await r.json();
      const chunkText = j.chunks.join("\n\n");
      console.log("Chunks from /chunks =>", chunkText);
      setPdfContextDebug(chunkText);
      return chunkText;
    } catch (err) {
      console.error("Error fetching PDF chunks:", err);
      return "";
    }
  };

  // Create a response event => AI answer
  const createResponseEvent = (userQuery, pdfContext) => {
    if (!dcRef.current) {
      console.log("No data channel available for response creation.");
      return;
    }
    console.log("Creating response with context =>", pdfContext);
    const eventObj = {
      type: "response.create",
      response: {
        modalities: ["audio","text"],
        instructions: `You have context from this PDF:\n${pdfContext}\nAnswer the user's question using only that info.\nUser said: ${userQuery}`,
        voice: "alloy",
        output_audio_format: "pcm16",
        temperature: 0.8,
        max_output_tokens: 800
      }
    };
    console.log("Sending 'response.create' event =>", eventObj);
    dcRef.current.send(JSON.stringify(eventObj));
  };

  // typed question => same approach
  const sendTextMessage = async () => {
    if (!dcRef.current || dcRef.current.readyState !== "open") {
      console.log("Data channel not open for typed question.");
      return;
    }
    const question = inputText.trim();
    if (!question) return;

    setMessages(prev => [...prev, { sender: "You", text: question }]);
    setInputText("");

    // fetch PDF context
    const pdfContext = await fetchPdfChunks(question);
    // create GPT response
    createResponseEvent(question, pdfContext);
  };

  return (
    <div className="app-container">
      <h1>Realtime Voice + PDF Q&A (Console Logs)</h1>
      <p>Status: {statusMessage}</p>

      <div className="session-controls">
        {!isConnected ? (
          <button onClick={initWebRTC}>Start Session</button>
        ) : (
          <button onClick={endSession}>End Session</button>
        )}
      </div>

      <div className="chat-container">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.sender === "You" ? "sent" : "received"}`}>
            <strong>{m.sender}:</strong> {m.text}
          </div>
        ))}
      </div>

      {/* Debug area to show chunk text */}
      <div style={{ marginTop: '1rem', background: '#f9f9f9', border: '1px solid #ccc', padding: '0.5rem'}}>
        <h3>PDF Context (Debug)</h3>
        <pre>{pdfContextDebug}</pre>
      </div>

      <div className="message-controls">
        <textarea
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          placeholder="Speak or type your question..."
        />
        <button onClick={sendTextMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;
