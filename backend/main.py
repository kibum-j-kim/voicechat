import os
import logging
import requests
import PyPDF2
import json
import hashlib
from typing import List, Dict
import numpy as np

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise ValueError("OPENAI_API_KEY not found in environment")

logging.basicConfig(level=logging.INFO)

CHUNK_EMBEDDINGS = []

# Persistent cache file for embeddings
CACHE_FILE = "embedding_cache.json"
embedding_cache = {}

if os.path.exists(CACHE_FILE):
    with open(CACHE_FILE, "r") as f:
        embedding_cache = json.load(f)

def get_text_hash(txt: str) -> str:
    """Generate a unique hash for the given text."""
    return hashlib.sha256(txt.encode("utf-8")).hexdigest()

def create_embedding(txt: str) -> List[float]:
    """
    Use the standard embeddings endpoint (text-embedding-ada-002) to embed text.
    """
    url = "https://api.openai.com/v1/embeddings"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json"
    }
    body = {
        "model": "text-embedding-ada-002",
        "input": txt
    }
    r = requests.post(url, headers=headers, json=body)
    r.raise_for_status()
    data = r.json()
    return data["data"][0]["embedding"]

def cached_create_embedding(txt: str) -> List[float]:
    """
    Check if the embedding exists in the persistent cache; if not, create it and update the cache.
    """
    key = get_text_hash(txt)
    if key in embedding_cache:
        logging.info("Cache hit for text.")
        return embedding_cache[key]
    
    logging.info("Cache miss for text. Creating new embedding.")
    emb = create_embedding(txt)
    embedding_cache[key] = emb
    with open(CACHE_FILE, "w") as f:
        json.dump(embedding_cache, f)
    return emb

def extract_text_from_pdf(pdf_path: str) -> str:
    text = ""
    with open(pdf_path, "rb") as f:
        reader = PyPDF2.PdfReader(f)
        for page in reader.pages:
            text += page.extract_text() + "\n"
    return text

def chunk_text(text: str, max_len: int) -> List[str]:
    paragraphs = text.split("\n")
    output = []
    current = ""
    for p in paragraphs:
        if len(current) + len(p) < max_len:
            current += p + "\n"
        else:
            output.append(current.strip())
            current = p + "\n"
    if current.strip():
        output.append(current.strip())
    return output

def cosine_similarity(a: List[float], b: List[float]) -> float:
    a_np = np.array(a)
    b_np = np.array(b)
    dot = float(np.dot(a_np, b_np))
    norm_a = float(np.linalg.norm(a_np))
    norm_b = float(np.linalg.norm(b_np))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)

def find_top_chunks(query: str, top_k=3) -> List[str]:
    """
    1) Create embedding for the query.
    2) Compare against each PDF chunk embedding.
    3) Return the top_k chunks.
    """
    query_emb = cached_create_embedding(query)
    scored = []
    for ce in CHUNK_EMBEDDINGS:
        sim = cosine_similarity(query_emb, ce["embedding"])
        scored.append((ce["content"], sim))
    scored.sort(key=lambda x: x[1], reverse=True)
    return [s[0] for s in scored[:top_k]]

@app.on_event("startup")
def load_pdf_and_embed():
    """
    Startup event that:
    1) Loads the PDF.
    2) Extracts the text.
    3) Chunks the text.
    4) Creates (or loads cached) embeddings for each chunk.
    """
    pdf_path = "pdf/Pennefather.pdf"
    logging.info(f"Loading PDF from: {pdf_path}")

    text = extract_text_from_pdf(pdf_path)
    chunks = chunk_text(text, 5000)
    logging.info(f"Extracted PDF text. Created {len(chunks)} chunks. Embedding them now...")

    for c in chunks:
        emb = cached_create_embedding(c)
        CHUNK_EMBEDDINGS.append({"content": c, "embedding": emb})

    logging.info("All PDF chunks embedded successfully.")

@app.get("/chunks")
def chunks_endpoint(q: str = Query(...)):
    """Return top relevant PDF chunks based on query."""
    top = find_top_chunks(q)
    return {"chunks": top}

@app.get("/session")
def get_session():
    """
    Create an ephemeral realtime session for retrieving responses,
    with no auto-response so that we can do chunk retrieval first.
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
        "instructions": "You are a friendly voice assistant that references PDF context when asked.",
        "voice": "ash",
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16",
        "input_audio_transcription": {
            "model": "whisper-1"
        },
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.7,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 800,
            "create_response": False
        }
    }
    resp = requests.post(url, headers=headers, json=body)
    resp.raise_for_status()
    session_data = resp.json()
    logging.info(f"Realtime session created: {session_data['id']}")
    return session_data

@app.get("/")
def index():
    return {"message": "Backend is up."}
