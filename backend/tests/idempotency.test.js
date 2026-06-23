// tests/idempotency.test.js
// Real Redis semantics via ioredis-mock (no live Redis needed).

const RedisMock = require('ioredis-mock');
const { claimOnce, releaseClaim } = require('../utils/idempotency');

describe('idempotency (claimOnce / releaseClaim)', () => {
    let redis;
    beforeEach(() => { redis = new RedisMock(); });
    afterEach(async () => { await redis.flushall(); });

    it('first claim succeeds, duplicate within TTL fails', async () => {
        expect(await claimOnce('job:1', 600, redis)).toBe(true);
        expect(await claimOnce('job:1', 600, redis)).toBe(false);
        expect(await claimOnce('job:1', 600, redis)).toBe(false);
    });

    it('different keys are independent', async () => {
        expect(await claimOnce('job:1', 600, redis)).toBe(true);
        expect(await claimOnce('job:2', 600, redis)).toBe(true);
    });

    it('releasing a claim allows it to be re-claimed (retry path)', async () => {
        expect(await claimOnce('job:1', 600, redis)).toBe(true);
        expect(await claimOnce('job:1', 600, redis)).toBe(false);
        await releaseClaim('job:1', redis);
        expect(await claimOnce('job:1', 600, redis)).toBe(true);
    });

    it('sets a TTL on the claim key', async () => {
        await claimOnce('job:ttl', 600, redis);
        const ttl = await redis.ttl('idem:job:ttl');
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(600);
    });
});
