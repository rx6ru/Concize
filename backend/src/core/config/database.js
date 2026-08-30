// Database connection and collection configuration

const DEV_PREFIX = process.env.DEV_PREFIX || '';

module.exports = {
    // Supabase Postgres: application data. Use the direct/session connection (port 5432).
    POSTGRES_URL: process.env.POSTGRES_URL,
    // Redis: idempotency, rate-limit cooldowns, and (Tier 2) live session state / reconnect backplane. BullMQ-compatible (ioredis); lazy, connects only when a Redis-backed feature is used.
    REDIS_URL: process.env.REDIS_URL,
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    // Defaulted rather than left undefined: unset, Qdrant was asked to create a collection
    // literally named "undefined" and nothing complained. These match .env.example.
    TRANSCRIPTION_COLLECTION: process.env.TRANSCRIPTION_COLLECTION || 'transcriptions',
    CHAT_COLLECTION: process.env.CHAT_COLLECTION || 'chats',
};
