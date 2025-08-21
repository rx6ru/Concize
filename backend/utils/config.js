// config.js
require('dotenv').config();

const config = {
    MONGODB_URL: process.env.MONGODB_URL,
    CLOUDAMQP_URL: process.env.CLOUDAMQP_URL,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    TRANSCRIPTION_COLLECTION: process.env.TRANSCRIPTION_COLLECTION,
    CHAT_COLLECTION: process.env.CHAT_COLLECTION,
    
    
    // Cloudinary credentials for audio storage
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
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
    "CLOUDINARY_API_SECRET"
];

required.forEach((key) => {
    if (!config[key]) {
        console.error(`ERROR: ${key} environment variable is not set.`);
        process.exit(1);
    }
});

module.exports = config;
