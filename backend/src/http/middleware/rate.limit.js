// Redis-backed per-user fixed-window rate limiter for HTTP routes.
//
// Fails open on any Redis problem, including a slow one: the shared client
// (infra/redis.js) sets maxRetriesPerRequest: null for BullMQ compatibility, so a command
// issued while Redis is unreachable would otherwise queue forever instead of rejecting. A
// short timeout around the check turns that hang into a fast fail-open instead.
// Missing REDIS_URL, a connection error, and a timeout are all treated the same way: allow the
// request through. A missed rate limit during a rare outage is preferable to blocking every
// user from a route that would otherwise work fine without Redis.

'use strict';

const { getRedis } = require('../../infra/redis');
const { createLogger } = require('../../core/logger');

const logger = createLogger('rateLimit');

const PREFIX = 'ratelimit:';

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`rate limit check timed out after ${ms}ms`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/**
 * @param {object} opts
 * @param {string} opts.name              identifies this limiter in the Redis key and logs
 * @param {number} opts.max               requests allowed per window
 * @param {number} opts.windowMs
 * @param {number} [opts.timeoutMs=200]   max time to wait on Redis before failing open
 * @param {() => object} [opts.getClient] injectable Redis client getter, default shared client
 * @param {(req: import('express').Request) => string|undefined} [opts.getUserId]
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter({ name, max, windowMs, timeoutMs = 200, getClient = getRedis, getUserId = (req) => req.user && req.user.id }) {
    const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

    return async function rateLimit(req, res, next) {
        const userId = getUserId(req);
        // authenticate() runs ahead of every v1 route; a missing user here is defense in depth.
        if (!userId) return next();

        const key = `${PREFIX}${name}:${userId}`;
        let count;
        try {
            const redis = getClient();
            count = await withTimeout(
                (async () => {
                    const c = await redis.incr(key);
                    if (c === 1) await redis.expire(key, windowSeconds);
                    return c;
                })(),
                timeoutMs,
            );
        } catch (err) {
            logger.warn('Rate limit check failed, allowing request', { name, userId, error: err.message });
            return next();
        }

        if (count > max) {
            logger.warn('Rate limit exceeded', { name, userId, count, max });
            return res.status(429).json({
                error: {
                    type: 'rate_limit_exceeded',
                    code: 'TOO_MANY_REQUESTS',
                    message: 'Too many requests. Please wait a moment and try again.',
                },
            });
        }
        return next();
    };
}

module.exports = { createRateLimiter };
