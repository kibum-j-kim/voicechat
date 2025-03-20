import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Disconnected");
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");

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

  // 🔹 Start WebRTC Session
  const initWebRTC = async () => {
    try {
      console.log("Requesting session...");
      const resp = await fetch("http://localhost:8000/session");
      const sessionData = await resp.json();

      ephemeralKeyRef.current = sessionData.client_secret.value;
      conversationIdRef.current = "";

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      audioRef.current = remoteAudio;
      pc.ontrack = (e) => {
        if (e.streams[0]) remoteAudio.srcObject = e.streams[0];
      };

      console.log("Requesting mic...");
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onmessage = async (evt) => {
        const eventData = JSON.parse(evt.data);
        console.log("Data event:", eventData);

        switch (eventData.type) {
          case 'conversation.created':
            conversationIdRef.current = eventData.conversation.id;
            break;

          case 'conversation.item.input_audio_transcription.completed':
            if (eventData.transcript?.trim()) {
              const userTranscript = eventData.transcript.trim();
              setMessages(prev => [...prev, { sender: "You", text: userTranscript }]);
              handleUserInput(userTranscript);
            }
            break;

          case 'response.audio_transcript.done':
            console.log("AI Final Transcript:", eventData.transcript);
            setMessages(prev => [...prev, { sender: "AI", text: eventData.transcript }]);
            setStatusMessage("Connected");
            break;

          case 'input_audio_buffer.speech_stopped':
            console.log("User stopped speaking, creating response...");
            setStatusMessage("Processing...");
            break;

          case 'response.audio.done':
            console.log("AI finished responding.");
            setStatusMessage("Connected");
            break;

          default:
            break;
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      console.log("Sending SDP offer...");
      const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${sessionData.client_secret.value}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      });

      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setIsConnected(true);
      setStatusMessage("Connected");
    } catch (err) {
      console.error("WebRTC error:", err);
      setStatusMessage("Error initializing WebRTC");
    }
  };

  // 🔹 End Session
  const endSession = () => {
    console.log("Ending session...");
    if (pcRef.current) pcRef.current.close();
    pcRef.current = null;
    setIsConnected(false);
    setStatusMessage("Disconnected");
    setMessages([]);
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
  };

  // 🔹 Handle Text or Audio Input
  const handleUserInput = async (query) => {
    console.log("Handling user input:", query);
    const pdfContext = await fetchPdfChunks(query);
    createResponseEvent(query, pdfContext);
  };

  // 🔹 Fetch PDF Chunks
  const fetchPdfChunks = async (query) => {
    console.log("Fetching PDF context...");
    try {
      const r = await fetch(`http://localhost:8000/chunks?q=${encodeURIComponent(query)}`);
      const j = await r.json();
      console.log("Received PDF context:", j.chunks);
      return j.chunks.join("\n\n");
    } catch (err) {
      console.error("Error fetching PDF:", err);
      return "";
    }
  };

  // 🔹 Create AI Response
  const createResponseEvent = (userQuery, pdfContext) => {
    if (!dcRef.current || dcRef.current.readyState !== "open") {
      console.log("❌ Data channel not ready for response.");
      return;
    }

    console.log("Sending AI response...");
    const msg = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Use the following PDF context:\n${pdfContext}\nUser: ${userQuery}`,
        voice: "ash",
        output_audio_format: "pcm16",
        max_output_tokens: 800
      }
    };

    dcRef.current.send(JSON.stringify(msg));
  };

  // 🔹 Send Text Message
  const sendTextMessage = async () => {
    if (!isConnected) await initWebRTC();
    const question = inputText.trim();
    if (!question) return;

    setMessages(prev => [...prev, { sender: "You", text: question }]);
    setInputText("");
    handleUserInput(question);
  };

  return (
    <div className="app-container">
      <h1>Voicechat</h1>
      <p>Status: {statusMessage}</p>

      <div className="controls">
        {!isConnected ? (
          <button onClick={initWebRTC}>Start Session</button>
        ) : (
          <>
            <button onClick={endSession}>End Session</button>
          </>
        )}
      </div>

      <div className="chat-container">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.sender === "You" ? "sent" : "received"}`}>
            <strong>{m.sender}:</strong> {m.text}
          </div>
        ))}
      </div>

      <div className="message-controls">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Type your question..."
        />
        <button onClick={sendTextMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;
