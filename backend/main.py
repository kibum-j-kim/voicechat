# main.py
import os
import json
import requests
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Allow CORS from your Vite frontend (adjust URL as needed)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    logging.error("OpenAI API Key not found. Please set the OPENAI_API_KEY environment variable.")
    raise ValueError("OpenAI API Key not found.")

logging.basicConfig(level=logging.INFO)

@app.get("/session")
def get_session():
    """
    Create an ephemeral realtime session and return the session details.
    The client_secret value in the session object is an ephemeral token safe for client-side use.
    """
    url = "https://api.openai.com/v1/realtime/sessions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
    }
    body = {
        "model": "gpt-4o-realtime-preview-2024-12-17",
        "modalities": ["audio", "text"],
        "instructions": "You are a friendly voice assistant. Respond with both voice and text.",
        "voice": "alloy",
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16"
    }
    resp = requests.post(url, headers=headers, json=body)
    resp.raise_for_status()
    session_data = resp.json()
    logging.info(f"Session created successfully: {session_data['id']}")
    return session_data

@app.get("/")
def index():
    return {"message": "FastAPI backend is running!"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
