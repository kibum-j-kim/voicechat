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
  
  // For partial AI transcripts
  const aiTranscriptBuffer = useRef("");

  useEffect(() => {
    const saved = localStorage.getItem("chatHistory");
    if (saved) setMessages(JSON.parse(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem("chatHistory", JSON.stringify(messages));
  }, [messages]);

  const initWebRTC = async () => {
    try {
      // 1. Get ephemeral token from your FastAPI
      const resp = await fetch("http://localhost:8000/session");
      const sessionData = await resp.json();
      const EPHEMERAL_KEY = sessionData.client_secret.value;

      // 2. Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 3. Set up remote audio
      const remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      audioRef.current = remoteAudio;
      pc.ontrack = (e) => {
        if (e.streams[0]) remoteAudio.srcObject = e.streams[0];
      };

      // 4. Capture user mic
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      // 5. Create data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      // 6. Listen for real-time events from OpenAI
      dc.onmessage = (e) => {
        const eventData = JSON.parse(e.data);

        // AI partial transcripts
        if (eventData.type === 'response.audio_transcript.delta') {
          aiTranscriptBuffer.current += eventData.delta;
        }
        // AI final transcript
        else if (eventData.type === 'response.audio_transcript.done') {
          setMessages(prev => [...prev, { sender: "AI", text: eventData.transcript }]);
          aiTranscriptBuffer.current = "";
        }
        // **User** audio transcripts
        else if (
          eventData.type === 'conversation.item.created' &&
          eventData.item.role === 'user' &&
          eventData.item.content[0]?.transcript
        ) {
          setMessages(prev => [...prev, {
            sender: "You",
            text: eventData.item.content[0].transcript
          }]);
        }

        // status indicators
        else if (eventData.type === 'input_audio_buffer.speech_started') {
          setStatusMessage("Listening...");
        }
        else if (eventData.type === 'response.created') {
          setStatusMessage("AI is speaking...");
        }
        else if (eventData.type === 'response.audio.done') {
          setStatusMessage("Connected");
        }
      };

      // 7. Create SDP offer & POST to OpenAI
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      });

      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setIsConnected(true);
      setStatusMessage("Connected");
    } catch (err) {
      console.error("WebRTC init error:", err);
      setStatusMessage("Error initializing WebRTC");
    }
  };

  const endSession = () => {
    pcRef.current?.close();
    pcRef.current = null;
    setIsConnected(false);
    setStatusMessage("Disconnected");
    setMessages([]);
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
  };

  // Sending typed text messages
  const sendTextMessage = () => {
    if (dcRef.current?.readyState === "open" && inputText.trim()) {
      dcRef.current.send(JSON.stringify({ type: "message", text: inputText }));
      setMessages(prev => [...prev, { sender: "You", text: inputText }]);
      setInputText("");
    }
  };

  return (
    <div className="app-container">
      <h1>Realtime Voice Chat with AI</h1>
      <p>Status: {statusMessage}</p>

      <div className="session-controls">
        {!isConnected ? (
          <button onClick={initWebRTC}>Start Session</button>
        ) : (
          <button onClick={endSession}>End Session</button>
        )}
      </div>

      <div className="chat-container">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.sender === "You" ? "sent" : "received"}`}>
            <strong>{msg.sender}:</strong> {msg.text}
          </div>
        ))}
      </div>

      <div className="message-controls">
        <textarea
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          placeholder="Type your message..."
        />
        <button onClick={sendTextMessage}>Send Message</button>
      </div>
    </div>
  );
}

export default App;
