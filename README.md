# 🎙️ Concize

A scalable system for real-time meeting transcription, summarization, and RAG-based chat.
This repo contains the **backend** (`backend/`) and the **Chrome extension** (`frontend/`).

## 🚀 Key Features

-   **Scalable Architecture**: Decoupled HTTP Server, Transcription Worker, and Summary Worker.
-   **High-Speed AI**:
    -   **Transcription**: Groq (Whisper V3) - Ultra-fast (~500x real-time).
    -   **Chat & Cleaning**: Groq (Defaults to `openai/gpt-oss-120b`).
    -   **Summarization**: Groq (`llama-3.1-8b-instant`) - Optimized for speed.
    -   **Embeddings**: Gemini - For semantic search.
-   **Self-Improving Summaries**: Real-time incremental meeting summarization.
-   **Auth & Multi-Tenancy**:
    -   **Supabase JWT** (asymmetric / JWKS, verified with `jose`); legacy `x-auth-code` retained as a flagged compat shim during migration.
    -   **Ownership-rooted API**: every meeting has an `owner_id`; access is enforced per-resource (cross-tenant → `404`), including the legacy routes and the Qdrant vector layer.
-   **Defense-in-Depth Security**:
    -   **Relevance Filter**: Summary-anchored query validation.
    -   **Input/Output Guardrails**: Prevention of prompt injections and leakage.
    -   **Secure Prompts**: All system prompts stored in gitignored `.secrets/`.
-   **Storage**:
    -   **Supabase Postgres**: Persistent data (Transcripts, Chat History, Summaries).
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

# Auth (dual-mode JWT + legacy)
AUTH_MODE=jwks                          # 'jwks' (default, asymmetric) or 'hs256'
SUPABASE_JWKS_URI=https://<project>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_ISSUER=https://<project>.supabase.co/auth/v1
SUPABASE_JWT_AUD=authenticated          # Default: 'authenticated'
SUPABASE_JWT_SECRET=                    # Required when AUTH_MODE=hs256
LEGACY_AUTH_ENABLED=                    # 'true'/'false'; defaults to true in dev, false in prod
LEGACY_OWNER_ID=legacy-owner           # Owner ID assigned to legacy x-auth-code requests

# Database
POSTGRES_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres?sslmode=require # Supabase: use direct/session connection (port 5432), NOT the transaction pooler (6543)
PGSSL=require # set to 'disable' only for local non-SSL Postgres
PG_POOL_MAX=10
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

### 3. Database Schema
Apply the Postgres schema to your Supabase database:
```bash
psql "$POSTGRES_URL" -f backend/db/schema.sql
```
Or drop `backend/db/schema.sql` into `supabase/migrations/` and run `supabase db push`.

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

## 🔐 Authentication

All endpoints require a **`Authorization: Bearer <supabase-jwt>`** header. The backend verifies the
token against the Supabase JWKS (or an HS256 secret if `AUTH_MODE=hs256`) and derives the user id
from the `sub` claim. During migration, a legacy `x-auth-code` is also accepted when
`LEGACY_AUTH_ENABLED=true` (defaults: on in dev, off in prod) and maps to a single `LEGACY_OWNER_ID`.

Authorization is **ownership-based**: a caller may only access meetings they own. Cross-tenant or
unknown meetings return **`404`** (no existence leak).

## 📡 Key API Endpoints

Canonical RESTful, ownership-rooted resource tree (`/api/v1`):

-   `POST /api/v1/meetings` — create a meeting (returns `{ meetingId }`)
-   `POST /api/v1/meetings/:meetingId/audio` — upload an audio chunk (multipart/form-data, field `audio`)
-   `GET  /api/v1/meetings/:meetingId/transcript` — full transcript
-   `POST /api/v1/meetings/:meetingId/chat` — RAG chat, SSE stream; body `{ "userPrompt": "..." }`
-   `GET  /api/v1/meetings/:meetingId/summary` — real-time incremental summary

> **Legacy routes** (`/api/v1/{audios,transcription,chat,meeting}`) remain as deprecated compat
> shims (meeting id in cookie/body), now also ownership-gated. New clients should use the routes above.

---

## 🧩 Frontend (Chrome Extension) Setup

The extension lives in `frontend/` and authenticates via Supabase (email/password) using the REST
auth API (no SDK — required for MV3 service workers).

1.  Copy the config template and fill in your values:
    ```bash
    cd frontend
    cp config.example.js config.js   # config.js is gitignored
    ```
    Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public anon key), and `BACKEND_URL`.
2.  Create a user in your Supabase project (dashboard, or the in-popup "Create Account" if email
    confirmation is disabled).
3.  Load the unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked →
    select `frontend/`), sign in, then record / transcribe / chat.

---

## 🧪 Testing

Run the full test suite (Unit + Integration):
```bash
npm test
```
