// configs/database.js
// Database connection and collection configuration

const DEV_PREFIX = process.env.DEV_PREFIX || '';

module.exports = {
    MONGODB_URL: process.env.MONGODB_URL,
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    TRANSCRIPTION_COLLECTION: process.env.TRANSCRIPTION_COLLECTION,
    CHAT_COLLECTION: process.env.CHAT_COLLECTION,
    MONGO_COLLECTION: `${DEV_PREFIX}transcriptions`,
};
