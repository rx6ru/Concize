### Concize RAG Pipeline Backend

A backend service for an audio transcription and RAG (Retrieval-Augmented Generation) pipeline. This service uses RabbitMQ for a message queue, Groq for transcription, and Qdrant as a vector database.

### Setup

1.  **Install Dependencies:**

    ```bash
    cd backend
    npm install
    ```

2.  **Environment Variables:**

    Create a `.env` file in the project root with the following variables.

    ```
    # Groq API for transcription and cleaning
    GROQ_API_KEY=<your_groq_api_key>

    # RabbitMQ for the message queue
    CLOUDAMQP_URL=<your_cloudamqp_url>

    # Qdrant for the vector database
    QDRANT_URL=<your_qdrant_url>
    QDRANT_API_KEY=<your_qdrant_api_key>
    COLLECTION=<your_qdrant_collection_name>

    # OpenAI API for embeddings (if not using a free alternative like Trelent)
    OPENAI_API_KEY=<your_openai_api_key>
    ```

### Running the Server

Start the application (make sure you are within /backend directory):

```bash
npm run dev
```

The server will run on the port specified in your `PORT` environment variable (default: 3000).