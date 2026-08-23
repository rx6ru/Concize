// Real Redis semantics via ioredis-mock (no live Redis needed), matching the pattern in
// tests/idempotency.test.js: the client is injected, the shared getRedis() singleton is never
// touched.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const RedisMock = require('ioredis-mock');
const { createRateLimiter } = require('../src/http/middleware/rate.limit');

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

let redis;
beforeEach(() => { redis = new RedisMock(); });
afterEach(async () => { await redis.flushall(); });

const build = (over = {}) => createRateLimiter({ name: 't', max: 3, windowMs: 1000, getClient: () => redis, ...over });

describe('under the limit', () => {
    it('allows every request up to max', async () => {
        const limiter = build();
        const req = { user: { id: 'u1' } };

        for (let i = 0; i < 3; i++) {
            const res = fakeRes();
            const next = jest.fn();
            await limiter(req, res, next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(res.statusCode).toBeNull();
        }
    });

    it('keeps different users independent', async () => {
        const limiter = build({ max: 1 });
        await limiter({ user: { id: 'a' } }, fakeRes(), jest.fn());

        const res = fakeRes();
        const next = jest.fn();
        await limiter({ user: { id: 'b' } }, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });
});

describe('over the limit', () => {
    it('refuses the request past max with a 429', async () => {
        const limiter = build();
        const req = { user: { id: 'u2' } };
        for (let i = 0; i < 3; i++) await limiter(req, fakeRes(), jest.fn());

        const res = fakeRes();
        const next = jest.fn();
        await limiter(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(429);
        expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    });

    it('keeps refusing on further attempts within the same window', async () => {
        const limiter = build({ max: 1 });
        const req = { user: { id: 'u3' } };
        await limiter(req, fakeRes(), jest.fn());

        const res1 = fakeRes();
        await limiter(req, res1, jest.fn());
        const res2 = fakeRes();
        await limiter(req, res2, jest.fn());

        expect(res1.statusCode).toBe(429);
        expect(res2.statusCode).toBe(429);
    });
});

describe('the window resets', () => {
    it('allows requests again once the window has elapsed', async () => {
        const limiter = build({ max: 1, windowMs: 1000 });
        const req = { user: { id: 'u4' } };

        await limiter(req, fakeRes(), jest.fn());
        const blocked = fakeRes();
        await limiter(req, blocked, jest.fn());
        expect(blocked.statusCode).toBe(429);

        // Redis EXPIRE is second-granularity; windowMs=1000 -> windowSeconds=1.
        await new Promise((r) => setTimeout(r, 1100));

        const after = fakeRes();
        const next = jest.fn();
        await limiter(req, after, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(after.statusCode).toBeNull();
    });
});

describe('Redis unavailable', () => {
    it('fails open when getClient throws', async () => {
        const limiter = createRateLimiter({
            name: 't', max: 1, windowMs: 1000,
            getClient: () => { throw new Error('REDIS_URL is not configured'); },
        });
        const res = fakeRes();
        const next = jest.fn();
        await limiter({ user: { id: 'u5' } }, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    it('fails open when a Redis command rejects', async () => {
        const badClient = { incr: () => Promise.reject(new Error('ECONNREFUSED')) };
        const limiter = createRateLimiter({ name: 't', max: 1, windowMs: 1000, getClient: () => badClient });
        const res = fakeRes();
        const next = jest.fn();
        await limiter({ user: { id: 'u6' } }, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    it('fails open quickly rather than waiting out a hung Redis command', async () => {
        // infra/redis.js's shared client sets maxRetriesPerRequest: null, so a real hung
        // connection would otherwise queue a command forever instead of rejecting it.
        const hungClient = { incr: () => new Promise(() => {}) };
        const limiter = createRateLimiter({
            name: 't', max: 1, windowMs: 1000, timeoutMs: 50, getClient: () => hungClient,
        });
        const res = fakeRes();
        const next = jest.fn();

        const start = Date.now();
        await limiter({ user: { id: 'u7' } }, res, next);
        const elapsed = Date.now() - start;

        expect(next).toHaveBeenCalledTimes(1);
        expect(elapsed).toBeLessThan(500);
    });
});

describe('no authenticated user', () => {
    it('passes through, since authenticate() already runs ahead of every v1 route', async () => {
        const limiter = build();
        const res = fakeRes();
        const next = jest.fn();
        await limiter({}, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });
});
