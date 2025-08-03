// config.js
require('dotenv').config(); // Load environment variables once at the very beginning

const config = {
    // RabbitMQ / CloudAMQP URL
    CLOUDAMQP_URL: process.env.CLOUDAMQP_URL,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    // Google Gemini API Key
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,

    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    COLLECTION: process.env.COLLECTION
};

// Basic validation to ensure essential variables are set
if (!config.CLOUDAMQP_URL) {
    console.error('ERROR: CLOUDAMQP_URL environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

if (!config.GROQ_API_KEY) {
    console.error('ERROR: GROQ_API_KEY environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

// Add validation for the new Gemini API Key
if (!config.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

if (!config.PORT) {
    console.error('ERROR: PORT environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

if (!config.NODE_ENV) {
    console.error('ERROR: NODE_ENV environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

if (!config.QDRANT_URL) {
    console.error('ERROR: QDRANT_URL environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

if (!config.QDRANT_API_KEY) {
    console.error('ERROR: QDRANT_API_KEY environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

if (!config.COLLECTION) {
    console.error('ERROR: COLLECTION environment variable is not set.');
    process.exit(1); // Exit if critical config is missing
}

module.exports = config;