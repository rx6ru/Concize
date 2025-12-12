// config.js
require('dotenv').config();

const config = {
    MONGODB_URL: process.env.MONGODB_URL,
    CLOUDAMQP_URL: process.env.CLOUDAMQP_URL,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    // Support multiple keys (comma-separated) or fallback to single key
    GEMINI_API_KEYS: (process.env.GEMINI_API_KEYS && process.env.GEMINI_API_KEYS.trim() !== '')
        ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k)
        : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : []),
    GEMINI_API_KEY: process.env.GEMINI_API_KEY, // Keep for backward compat / single use if needed

    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    TRANSCRIPTION_COLLECTION: process.env.TRANSCRIPTION_COLLECTION,
    CHAT_COLLECTION: process.env.CHAT_COLLECTION,

    // Dev Environment Isolation - prefix for shared resources
    DEV_PREFIX: process.env.DEV_PREFIX || '',
    AUDIO_QUEUE: `${process.env.DEV_PREFIX || ''}audio_queue`,
    MONGO_COLLECTION: `${process.env.DEV_PREFIX || ''}transcriptions`,

    // Cloudinary credentials for audio storage
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,

    // Temp Auth
    ALLOWED_AUTH_CODES: (process.env.ALLOWED_AUTH_CODES && process.env.ALLOWED_AUTH_CODES.trim() !== '')
        ? process.env.ALLOWED_AUTH_CODES.split(',').map(c => c.trim())
        : ['temp-secret-123'],
};

const required = [
    "CLOUDAMQP_URL",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "PORT",
    "NODE_ENV",
    "QDRANT_URL",
    "QDRANT_API_KEY",
    "TRANSCRIPTION_COLLECTION",
    "CHAT_COLLECTION",
    "MONGODB_URL",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "ALLOWED_AUTH_CODES"
];

required.forEach((key) => {
    if (!config[key]) {
        console.error(`ERROR: ${key} environment variable is not set.`);
        process.exit(1);
    }
});

module.exports = config;
