// src/App.jsx
import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
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

  // Initialize the WebRTC connection using ephemeral token from backend /session
  const initWebRTC = async () => {
    try {
      // 1. Fetch ephemeral session details from your FastAPI backend
      const response = await fetch("http://localhost:8000/session");
      const sessionData = await response.json();
      const EPHEMERAL_KEY = sessionData.client_secret.value;
      console.log("Ephemeral key:", EPHEMERAL_KEY);

      // 2. Create a new RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 3. Set up remote audio playback by creating an <audio> element
      const remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      audioRef.current = remoteAudio;
      pc.ontrack = (e) => {
        if (e.streams && e.streams[0]) {
          remoteAudio.srcObject = e.streams[0];
        }
      };

      // 4. Get local microphone audio and add it to the peer connection
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      // 5. Create a data channel for sending/receiving realtime events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (e) => {
        try {
          const eventData = JSON.parse(e.data);
          console.log("Data channel message:", eventData);
          setMessages((prev) => [...prev, { sender: "AI", text: eventData.text || JSON.stringify(eventData) }]);
        } catch (err) {
          console.error("Error parsing data channel message:", err);
        }
      };

      // 6. Create an SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Send the SDP offer to OpenAI realtime API using the ephemeral token.
      // Note: The offer's SDP is sent as plain text with Content-Type "application/sdp".
      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          "Authorization": `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp"
        },
      });
      const answerSdp = await sdpResponse.text();
      const answer = {
        type: "answer",
        sdp: answerSdp,
      };
      await pc.setRemoteDescription(answer);
      console.log("WebRTC connection established");
      setIsConnected(true);
      setStatusMessage("Connected");
    } catch (error) {
      console.error("Error initializing WebRTC:", error);
      setStatusMessage("Error initializing WebRTC");
    }
  };

  const endSession = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
      setIsConnected(false);
      setStatusMessage("Disconnected");
      setMessages([]);
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.srcObject = null;
      }
    }
  };

  // For sending text messages via the data channel
  const sendTextMessage = () => {
    if (dcRef.current && dcRef.current.readyState === "open" && inputText.trim() !== "") {
      const msg = { type: "message", text: inputText };
      dcRef.current.send(JSON.stringify(msg));
      setMessages((prev) => [...prev, { sender: "You", text: inputText }]);
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
            <strong>{msg.sender}: </strong> {msg.text}
          </div>
        ))}
      </div>
      <div className="message-controls">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Type your message..."
        />
        <button onClick={sendTextMessage}>Send Message</button>
      </div>
      {/* (Optional) You can later add buttons to start/stop audio recording with VAD */}
    </div>
  );
}

export default App;
