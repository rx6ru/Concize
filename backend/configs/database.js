// configs/database.js
// Database connection and collection configuration

const DEV_PREFIX = process.env.DEV_PREFIX || '';

module.exports = {
    // Supabase Postgres — application data. Use the direct/session connection (port 5432).
    POSTGRES_URL: process.env.POSTGRES_URL,
    // Redis — idempotency, rate-limit cooldowns, and (Tier 2) live session state / reconnect backplane.
    // BullMQ-compatible (ioredis). Lazy: nothing connects until a Redis-backed feature is used.
    REDIS_URL: process.env.REDIS_URL,
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    TRANSCRIPTION_COLLECTION: process.env.TRANSCRIPTION_COLLECTION,
    CHAT_COLLECTION: process.env.CHAT_COLLECTION,
};
