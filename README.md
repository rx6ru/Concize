## 🎙️ Concize RAG Pipeline Backend

A backend service for an audio transcription and **RAG** (Retrieval-Augmented Generation) pipeline.
This service uses:

* 🐇 **RabbitMQ** – for message queuing
* 🎧 **Groq** – for audio transcription
* 🧠 **Qdrant** – as the vector database for semantic search
* 🌐 **Gemini API** – for embedding generation

---

## ⚙️ Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

---

### 2. Environment Variables

Create a `.env` file in the project root with the following variables:

```env
# Groq API for transcription and cleaning
GROQ_API_KEY=<your_groq_api_key>

# RabbitMQ for the message queue
CLOUDAMQP_URL=<your_cloudamqp_url>

# Qdrant for the vector database
QDRANT_URL=<your_qdrant_url>
QDRANT_API_KEY=<your_qdrant_api_key>
TRANSCRIPTION_COLLECTION=<your_qdrant_collection_name_for_transcription>
CHAT_COLLECTION=<your_qdrant_collection_name_for_chat>

# Google Gemini API for embeddings
GEMINI_API_KEY=<your_gemini_api_key>
```


---

## 📡 API Endpoints

### `POST /api/meeting/start`

* **Description**: Starts the worker process that consumes messages from the RabbitMQ queue.
* **Request Body**: *None*
* **Response**:

  ```json
  { "message": "Worker started." }
  ```

---

### `POST /api/audios/`

* **Description**: Uploads an audio file for transcription and embedding.
  This request is accepted only if the worker is running.
* **Request**: `multipart/form-data`

  * Key: `audio`
  * Constraints: Must be an audio file less than **15 minutes** long.
* **Response**:

  ```json
  { "message": "Audio received and added to queue." }
  ```

---

### `POST /api/meeting/stop`

* **Description**: Stops the worker process.
  The worker will finish current tasks before shutting down.
* **Request Body**: *None*
* **Response**:

  ```json
  { "message": "Worker stopping..." }
  ```

---

### `GET /api/meeting/status`

* **Description**: Retrieves the current status of the worker process.
* **Request**: *None*
* **Response**:

  ```json
  { "status": "running" }
  ```

---

## 🔁 API Call Workflow

To use the pipeline, follow this sequence:

1. **Start the Worker**

   ```http
   POST /api/meeting/start
   ```

2. **Upload Audio**

   ```http
   POST /api/audios/
   ```

   * Include your `.mp3`/`.wav`/`.m4a` file (max 15 minutes) as `audio`.

3. **Check Status (Optional)**

   ```http
   GET /api/meeting/status
   ```

4. **Stop the Worker**

   ```http
   POST /api/meeting/stop
   ```

---

## 🚀 Running the Server

Start the backend server (inside the `/backend` directory):

```bash
npm run dev
```

The server will run on the port specified in your `.env` as `PORT`

> Default: `3000`

