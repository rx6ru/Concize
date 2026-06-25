//
// Idempotency guard for at-least-once delivery: any queue (RabbitMQ or BullMQ) can re-deliver a
// message, so a consumer must not double-process. `claimOnce` atomically reserves a one-time slot for
// a key (Redis SET NX EX); only the first caller within the TTL window gets `true`.
//
// Queue-agnostic on purpose — the HELPER is reusable regardless of which queue we keep; wiring it into a
// specific consumer is done alongside the queue choice. `redis` is injectable for tests.

const { getRedis } = require('./redis');

const PREFIX = 'idem:';

/**
 * Atomically claims a one-time processing slot.
 * @param {string} key stable id (e.g. `${meetingId}:chunk:${index}:${hash}`)
 * @param {number} [ttlSeconds=600] how long the claim is remembered (≥ max retry window)
 * @param {object} [redis] injectable client (default: shared)
 * @returns {Promise<boolean>} true if THIS caller acquired it (process now); false if duplicate
 */
async function claimOnce(key, ttlSeconds = 600, redis = getRedis()) {
    const res = await redis.set(`${PREFIX}${key}`, '1', 'NX', 'EX', ttlSeconds);
    return res === 'OK';
}

/**
 * Releases a claim so the key can be retried (call on processing failure so retries get a fresh attempt).
 * @param {string} key
 * @param {object} [redis]
 */
async function releaseClaim(key, redis = getRedis()) {
    await redis.del(`${PREFIX}${key}`);
}

module.exports = { claimOnce, releaseClaim };
