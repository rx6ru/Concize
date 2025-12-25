# 🎙️ Concize Backend

A production-ready backend for scalable real-time meeting transcription, summarization, and RAG-based chat.

## 🚀 Key Features

-   **Scalable Architecture**: Decoupled HTTP Server, Transcription Worker, and Summary Worker.
-   **High-Speed AI**:
    -   **Transcription**: Groq (Whisper V3) - Ultra-fast (~500x real-time).
    -   **Chat & Cleaning**: Groq (Defaults to `openai/gpt-oss-120b`).
    -   **Summarization**: Groq (`llama-3.1-8b-instant`) - Optimized for speed.
    -   **Embeddings**: Gemini - For semantic search.
-   **Self-Improving Summaries**: Real-time incremental meeting summarization.
-   **Defense-in-Depth Security**:
    -   **Relevance Filter**: Summary-anchored query validation.
    -   **Input/Output Guardrails**: Prevention of prompt injections and leakage.
    -   **Secure Prompts**: All system prompts stored in gitignored `.secrets/`.
-   **Storage**:
    -   **MongoDB**: Persistent data (Transcripts, Chat History, Summaries).
    -   **Cloudinary**: Temporary audio storage.
    -   **Qdrant**: Vector database for RAG.

---

## 🏗️ System Architecture

The system runs as **distributed processes** communicating via RabbitMQ.

1.  **Main API (Express)**: Handles Uploads, Chat, and Meeting Management.
2.  **Transcription Worker**: Consumes `audioQueue`. Fetches from Cloudinary → Transcribes (Groq) → Clean (Groq `gpt-oss-120b`) → Embed (Gemini/Qdrant) → Publishes to `summaryQueue`.
3.  **Summary Worker**: Consumes `summaryQueue`. Generates incremental summaries via LLM (`llama-3.1-8b-instant`).

---

## 🛠️ Setup

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Environment Variables (`.env`)
Create a `.env` file in `backend/`:

```env
# Server
PORT=5001
NODE_ENV=development
DEV_PREFIX=dev_ # For data isolation

# Security
ALLOWED_AUTH_CODES=your-secret-code,another-code

# Database
MONGODB_URL=mongodb+srv://...
CLOUDAMQP_URL=amqps://...
QDRANT_URL=https://...
QDRANT_API_KEY=...

# Models
GROQ_API_KEYS=key1,key2,key3
GEMINI_API_KEYS=key1,key2
GROQ_CHAT_MODEL=openai/gpt-oss-120b # Optional override

# Storage
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# Queues
AUDIO_QUEUE=audio_processing_queue
SUMMARY_QUEUE=meeting_summary_queue
```

---

## 🏃 Run Instructions

Run the system in **two separate terminals**:

### Terminal 1: Server + Transcription
Starts the API server and the audio transcription worker.
```bash
npm run dev
```

### Terminal 2: Summary Worker
Starts the background summarization service.
```bash
npm run worker:summary
```

*Note: For production, use `npm start` instead of `npm run dev`.*

---

## 📡 Key API Endpoints

### Meeting Management
-   `POST /api/meeting/start` - Initialize session (returns `jobId`)
-   `GET /api/meeting/:jobId` - Get meeting status
-   `GET /api/meeting/:jobId/summary` - **[NEW]** Get real-time summary

### Audio
-   `POST /api/audios` - Upload audio chunk (multipart/form-data)

### Chat (RAG)
-   `POST /api/chat` - Chat with meeting context
    -   Body: `{ "message": "...", "jobId": "..." }`
    -   Streamed Response (SSE)

---

## 🧪 Testing

Run the full test suite (Unit + Integration):
```bash
npm test
```
