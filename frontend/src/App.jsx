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
  const audioRef = useRef(new Audio());

  const ephemeralKeyRef = useRef("");
  const conversationIdRef = useRef("");

  useEffect(() => {
    const saved = localStorage.getItem("chatHistory");
    if (saved) setMessages(JSON.parse(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem("chatHistory", JSON.stringify(messages));
  }, [messages]);

  // 🔹 Start WebRTC Session (FIXED)
  const initWebRTC = async () => {
    if (isConnected) return; // Prevent multiple connections

    try {
      console.log("Requesting session...");
      const resp = await fetch("http://localhost:8000/session");
      const sessionData = await resp.json();

      if (!sessionData.client_secret?.value) {
        throw new Error("Invalid session data received.");
      }

      ephemeralKeyRef.current = sessionData.client_secret.value;
      conversationIdRef.current = "";

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      console.log("Requesting local audio...");
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = (e) => {
        console.log("Received remote track");
        if (e.streams[0]) {
          audioRef.current.srcObject = e.streams[0];
          audioRef.current.play();
        }
      };

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
            setMessages(prev => [...prev, { sender: "AI", text: eventData.transcript }]);
            break;

          case 'response.created':
            setStatusMessage("AI is responding...");
            break;

          case 'response.audio.done':
            setStatusMessage("Connected");
            break;

          default:
            break;
        }
      };

      // Create SDP offer and set local description
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
      if (!answerSdp.trim()) {
        throw new Error("Empty SDP response received.");
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setIsConnected(true);
      setStatusMessage("Connected");
      console.log("WebRTC connection established!");
    } catch (err) {
      console.error("WebRTC error:", err);
      setStatusMessage("Error initializing WebRTC");
    }
  };

  // 🔹 End Session (FIXED)
  const endSession = () => {
    console.log("Ending session...");
    if (pcRef.current) pcRef.current.close();
    pcRef.current = null;
    setIsConnected(false);
    setStatusMessage("Disconnected");
    setMessages([]);
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    audioRef.current.srcObject = null;
  };

  // 🔹 Handle Text Input
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
      return j.chunks.join("\n\n");
    } catch (err) {
      console.error("Error fetching PDF:", err);
      return "";
    }
  };

  // 🔹 Create AI Response (FIXED)
  const createResponseEvent = (userQuery, pdfContext) => {
    if (!dcRef.current || dcRef.current.readyState !== "open") return;

    console.log("Sending AI response...");
    const msg = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Use the following PDF context:\n${pdfContext}\nUser: ${userQuery} \nAnswer in layman terms as if to a highschooler`,
        voice: "ash",
        output_audio_format: "pcm16",
        max_output_tokens: 400
      }
    };

    dcRef.current.send(JSON.stringify(msg));
  };

  // 🔹 Send Text Message (FIXED)
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