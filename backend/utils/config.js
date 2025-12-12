// config.js
require('dotenv').config();

const config = {
    MONGODB_URL: process.env.MONGODB_URL,
    CLOUDAMQP_URL: process.env.CLOUDAMQP_URL,
    GROQ_API_KEYS: (process.env.GROQ_API_KEYS && process.env.GROQ_API_KEYS.trim() !== '')
        ? process.env.GROQ_API_KEYS.split(',').map(k => k.trim()).filter(k => k)
        : (process.env.GROQ_API_KEY ? [process.env.GROQ_API_KEY] : []),
    // Gemini API Keys (comma-separated list, supports 1 or more keys)
    GEMINI_API_KEYS: (process.env.GEMINI_API_KEYS && process.env.GEMINI_API_KEYS.trim() !== '')
        ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k)
        : [],

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
    // "GROQ_API_KEY", // Removed single key check
    // Accept either GEMINI_API_KEY or GEMINI_API_KEYS
    // Validated by custom check below
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

// Custom validation: GROQ_API_KEYS must be configured with at least one key
if (!config.GROQ_API_KEYS || config.GROQ_API_KEYS.length === 0) {
    console.error('ERROR: GROQ_API_KEYS environment variable is not set or is empty. Provide at least one API key.');
    process.exit(1);
}

// Custom validation: GEMINI_API_KEYS must be configured for embeddings
if (!config.GEMINI_API_KEYS || config.GEMINI_API_KEYS.length === 0) {
    console.error('ERROR: GEMINI_API_KEYS environment variable is not set or is empty. Embeddings require at least one Gemini API key.');
    process.exit(1);
}

module.exports = config;
