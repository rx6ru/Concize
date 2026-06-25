//
// Single Redis access point (ioredis). Used for idempotency, rate-limit cooldowns, and — in Tier 2 —
// live session state + reconnect/sticky-session backplane. ioredis is BullMQ-compatible, so if we later
// consolidate the batch queue onto BullMQ it runs on this same client.
//
// LAZY: the connection is only created when getRedis() is first called, so the app boots fine without
// REDIS_URL until a Redis-backed feature is actually exercised.

const Redis = require('ioredis');
const config = require('../core/config');
const { createLogger } = require('../core/logger');

const logger = createLogger('redis');

let client = null;

/** Returns the shared ioredis client, connecting on first use. */
function getRedis() {
    if (client) return client;
    const url = config.database.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is not configured');
    client = new Redis(url, {
        // BullMQ requires this; harmless for plain use. Avoids ioredis aborting commands on reconnect.
        maxRetriesPerRequest: null,
    });
    client.on('error', (e) => logger.error('Redis error', { error: e.message }));
    client.on('connect', () => logger.info('Connected to Redis'));
    return client;
}

/** Verifies connectivity (call only where Redis is actually required). */
async function pingRedis() {
    await getRedis().ping();
    logger.info('Redis ping OK');
}

/** Closes the client (graceful shutdown / tests). */
async function closeRedis() {
    if (client) {
        try { await client.quit(); } catch { /* noop */ }
        client = null;
    }
}

/** Test seam: inject an ioredis-mock (or other) client. */
function _setClientForTesting(testClient) {
    client = testClient;
}

module.exports = { getRedis, pingRedis, closeRedis, _setClientForTesting };
