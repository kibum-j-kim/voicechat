import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Disconnected");
  const [messages, setMessages] = useState([]);
  const [partialAiMessage, setPartialAiMessage] = useState(""); // For partial transcripts
  const [inputText, setInputText] = useState("");
  const [pdfContextDebug, setPdfContextDebug] = useState("");

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);

  const ephemeralKeyRef = useRef("");
  const conversationIdRef = useRef("");

  useEffect(() => {
    const saved = localStorage.getItem("chatHistory");
    if (saved) setMessages(JSON.parse(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem("chatHistory", JSON.stringify(messages));
  }, [messages]);

  // 1) Start Session
  const initWebRTC = async () => {
    try {
      console.log("Requesting ephemeral session /session...");
      const resp = await fetch("http://localhost:8000/session");
      const sessionData = await resp.json();
      console.log("Session data =>", sessionData);

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
        console.log("Received remote track =>", e.streams);
        if (e.streams[0]) remoteAudio.srcObject = e.streams[0];
      };

      // Local mic
      console.log("Requesting local mic...");
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      // Data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onmessage = async (evt) => {
        const eventData = JSON.parse(evt.data);
        console.log("Data channel =>", eventData);

        switch (eventData.type) {
          case 'conversation.created':
            conversationIdRef.current = eventData.conversation.id;
            console.log("conversation.created =>", eventData.conversation);
            break;

          // We won't rely on conversation.item.created for final transcripts
          // because your logs show the final text in input_audio_transcription.completed or partial deltas
          case 'conversation.item.input_audio_transcription.completed':
            // The final user transcript
            if (eventData.transcript?.trim()) {
              const userTranscript = eventData.transcript.trim();
              console.log("User final transcript =>", userTranscript);
              setMessages(prev => [...prev, { sender: "You", text: userTranscript }]);

              // fetch PDF chunks, create AI response
              const context = await fetchPdfChunks(userTranscript);
              createResponseEvent(userTranscript, context);
            }
            break;

          // AI partial transcripts => we show them word-by-word
          case 'response.audio_transcript.delta': {
            // Add partial text to partialAiMessage
            // We'll add a space to separate words
            setPartialAiMessage((prev) => prev + eventData.delta + " ");
            break;
          }

          // AI final transcripts => finalize partial
          case 'response.audio_transcript.done': {
            // Combine any leftover partial text with the final
            // Then push to chat
            const finalText = (partialAiMessage + eventData.transcript).trim();
            console.log("AI final transcript =>", finalText);

            // Add final AI message to chat
            setMessages((prev) => [...prev, { sender: "AI", text: finalText }]);
            setPartialAiMessage(""); // reset partial
            break;
          }

          // Additional "speech detection" events
          case 'input_audio_buffer.speech_started':
            console.log("Speech started =>", eventData);
            setStatusMessage("Listening...");
            break;
          case 'input_audio_buffer.speech_stopped':
            console.log("Speech stopped =>", eventData);
            break;

          // AI is responding
          case 'response.created':
            console.log("response.created => AI is speaking...");
            setStatusMessage("AI is speaking...");
            break;

          case 'response.audio.done':
            console.log("AI audio done =>");
            setStatusMessage("Connected");
            break;

          default:
            break;
        }
      };

      // Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      console.log("Sending offer => GPT Realtime");
      const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${sessionData.client_secret.value}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      });

      const answerSdp = await sdpResp.text();
      console.log("Got answer => setting remote desc...");
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setIsConnected(true);
      setStatusMessage("Connected");
      console.log("WebRTC established!");
    } catch (err) {
      console.error("initWebRTC =>", err);
      setStatusMessage("Error initializing WebRTC");
    }
  };

  const endSession = () => {
    console.log("Ending session =>");
    if (pcRef.current) pcRef.current.close();
    pcRef.current = null;
    setIsConnected(false);
    setStatusMessage("Disconnected");
    setMessages([]);
    setPartialAiMessage("");
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
  };

  // fetch PDF chunk
  const fetchPdfChunks = async (query) => {
    console.log("Calling /chunks =>", query);
    try {
      const r = await fetch(`http://localhost:8000/chunks?q=${encodeURIComponent(query)}`);
      const j = await r.json();
      const chunkText = j.chunks.join("\n\n");
      console.log("PDF chunk =>", chunkText);
      setPdfContextDebug(chunkText);
      return chunkText;
    } catch (err) {
      console.error("fetchPdfChunks error =>", err);
      return "";
    }
  };

  // create AI response => pass PDF context
  const createResponseEvent = (userQuery, pdfContext) => {
    if (!dcRef.current) {
      console.log("No data channel for response creation");
      return;
    }
    console.log("Manual response =>", pdfContext);
    const msg = {
      type: "response.create",
      response: {
        modalities: ["audio","text"],
        instructions: `You are helpful cheerful assistant who speaks in layman terms as if you are speaking to a highschooler. You have context from PDF:\n${pdfContext}\nAnswer using that info directly x -> y. if you don't know say you don't know.\nUser said: ${userQuery}`,
        voice: "ballad",
        output_audio_format: "pcm16",
        temperature: 0.8,
        max_output_tokens: 800
      }
    };
    console.log("Sending response.create =>", msg);
    dcRef.current.send(JSON.stringify(msg));
  };

  // typed question => same approach
  const sendTextMessage = async () => {
    if (!dcRef.current || dcRef.current.readyState !== "open") {
      console.log("Data channel not open for typed question");
      return;
    }
    const question = inputText.trim();
    if (!question) return;

    setMessages((prev) => [...prev, { sender: "You", text: question }]);
    setInputText("");

    // fetch PDF chunk
    const pdfContext = await fetchPdfChunks(question);
    createResponseEvent(question, pdfContext);
  };

  return (
    <div className="app-container">
      <h1>Voicechat</h1>
      <p>Status: {statusMessage}</p>

      <div className="controls">
        {!isConnected ? (
          <button onClick={initWebRTC}>Start Session</button>
        ) : (
          <button onClick={endSession}>End Session</button>
        )}
      </div>

      {/* Chat Area */}
      <div className="chat-container">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.sender === "You" ? "sent" : "received"}`}>
            <strong>{m.sender}:</strong> {m.text}
          </div>
        ))}

        {/* Show partial AI message if any */}
        {partialAiMessage && (
          <div className="message received partial">
            <strong>AI (typing):</strong> {partialAiMessage}
          </div>
        )}
      </div>

      {/* Debug area for PDF context */}
      {/* <div className="pdf-debug">
        <h3>PDF Context (Debug)</h3>
        <pre>{pdfContextDebug}</pre>
      </div> */}

      <div className="message-controls">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Type or ask your question..."
        />
        <button onClick={sendTextMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;
