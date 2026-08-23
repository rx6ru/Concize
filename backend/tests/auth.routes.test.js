jest.mock('../src/auth/user.repository', () => ({
    createUser: jest.fn(),
    findUserByEmail: jest.fn(),
}));

// Must run before any require that can pull in core/config (infra/redis does): config reads
// this env var once, at first require, and caches it on the config object.
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-long-enough-for-hs256';

const request = require('supertest');
const express = require('express');
const RedisMock = require('ioredis-mock');
const { createUser, findUserByEmail } = require('../src/auth/user.repository');
const { hashPassword } = require('../src/auth/password');
const { _setClientForTesting } = require('../src/infra/redis');

const authRoutes = require('../src/http/routes/v1/auth.routes');

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRoutes);

// The routes' rate limiters share the module-level Redis client (infra/redis.js). A fresh mock
// per test keeps requests in one test from tripping the limit in another, and keeps the real
// getRedis() singleton, and any live REDIS_URL, out of this file entirely.
let redis;
beforeEach(() => {
    jest.clearAllMocks();
    redis = new RedisMock();
    _setClientForTesting(redis);
});
afterEach(async () => {
    await redis.flushall();
    _setClientForTesting(null);
});

describe('signup', () => {
    it('creates an account and hands back a usable token', async () => {
        findUserByEmail.mockResolvedValue(null);
        createUser.mockResolvedValue({ id: 'u1', email: 'a@b.co' });

        const res = await request(app).post('/api/v1/auth/signup')
            .send({ email: 'a@b.co', password: 'a-real-password' });

        expect(res.status).toBe(201);
        expect(typeof res.body.token).toBe('string');
        // The password must never be what gets stored.
        expect(createUser.mock.calls[0][1]).not.toContain('a-real-password');
    });

    it('refuses an email already registered', async () => {
        findUserByEmail.mockResolvedValue({ id: 'u1' });
        const res = await request(app).post('/api/v1/auth/signup')
            .send({ email: 'a@b.co', password: 'a-real-password' });
        expect(res.status).toBe(409);
        expect(createUser).not.toHaveBeenCalled();
    });

    it('rejects a malformed email', async () => {
        const res = await request(app).post('/api/v1/auth/signup')
            .send({ email: 'not-an-email', password: 'a-real-password' });
        expect(res.status).toBe(400);
    });

    it('rejects a password under the floor', async () => {
        const res = await request(app).post('/api/v1/auth/signup')
            .send({ email: 'a@b.co', password: 'short' });
        expect(res.status).toBe(400);
    });

    it('rejects a missing body without throwing', async () => {
        const res = await request(app).post('/api/v1/auth/signup').send({});
        expect(res.status).toBe(400);
    });
});

describe('login', () => {
    it('accepts the right password', async () => {
        findUserByEmail.mockResolvedValue({
            id: 'u1', email: 'a@b.co', passwordHash: await hashPassword('a-real-password'),
        });
        const res = await request(app).post('/api/v1/auth/login')
            .send({ email: 'a@b.co', password: 'a-real-password' });
        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
    });

    it('rejects the wrong password', async () => {
        findUserByEmail.mockResolvedValue({
            id: 'u1', email: 'a@b.co', passwordHash: await hashPassword('a-real-password'),
        });
        const res = await request(app).post('/api/v1/auth/login')
            .send({ email: 'a@b.co', password: 'the-wrong-password' });
        expect(res.status).toBe(401);
    });

    it('says the same thing for an unknown account as for a wrong password', async () => {
        // Telling them apart reveals which emails are registered here.
        findUserByEmail.mockResolvedValue({
            id: 'u1', email: 'a@b.co', passwordHash: await hashPassword('a-real-password'),
        });
        const wrong = await request(app).post('/api/v1/auth/login')
            .send({ email: 'a@b.co', password: 'the-wrong-password' });

        findUserByEmail.mockResolvedValue(null);
        const unknown = await request(app).post('/api/v1/auth/login')
            .send({ email: 'nobody@b.co', password: 'the-wrong-password' });

        expect(unknown.status).toBe(wrong.status);
        expect(unknown.body.error).toBe(wrong.body.error);
    });
});

describe('rate limiting', () => {
    it('refuses login past the limit with 429, allows requests under it', async () => {
        findUserByEmail.mockResolvedValue(null);

        for (let i = 0; i < 10; i++) {
            const res = await request(app).post('/api/v1/auth/login')
                .send({ email: 'a@b.co', password: 'the-wrong-password' });
            expect(res.status).toBe(401);
        }

        const blocked = await request(app).post('/api/v1/auth/login')
            .send({ email: 'a@b.co', password: 'the-wrong-password' });
        expect(blocked.status).toBe(429);
    });

    it('refuses signup past the limit with 429, allows requests under it', async () => {
        findUserByEmail.mockResolvedValue(null);
        createUser.mockImplementation(async (email) => ({ id: 'x', email }));

        for (let i = 0; i < 5; i++) {
            const res = await request(app).post('/api/v1/auth/signup')
                .send({ email: `u${i}@b.co`, password: 'a-real-password' });
            expect(res.status).toBe(201);
        }

        const blocked = await request(app).post('/api/v1/auth/signup')
            .send({ email: 'u5@b.co', password: 'a-real-password' });
        expect(blocked.status).toBe(429);
    });
});

describe('timing side channel', () => {
    it('an unknown email costs about as much as a wrong password', async () => {
        const stored = await hashPassword('a-real-password-99');
        findUserByEmail.mockImplementation(async (email) =>
            (email === 'known@b.co' ? { id: 'u1', email, passwordHash: stored } : null));

        const time = async (email) => {
            const start = process.hrtime.bigint();
            await request(app).post('/api/v1/auth/login').send({ email, password: 'the-wrong-password' });
            return Number(process.hrtime.bigint() - start) / 1e6;
        };

        // Interleaved, not two separate loops, so a system getting busier over time doesn't bias
        // one path's average over the other's.
        const ITER = 4;
        let wrongTotal = 0;
        let unknownTotal = 0;
        for (let i = 0; i < ITER; i++) {
            wrongTotal += await time('known@b.co');
            unknownTotal += await time('unknown@b.co');
        }

        const wrongMean = wrongTotal / ITER;
        const unknownMean = unknownTotal / ITER;
        const ratio = Math.max(wrongMean, unknownMean) / Math.min(wrongMean, unknownMean);

        // Generous on purpose: scrypt dominates either path's cost (tens of ms), well past
        // ordinary Express/JSON/loopback jitter, so a real fix keeps this near 1x. Measured in
        // this repo: ~110ms (wrong password) vs ~1-2ms (unknown email, unfixed) -- a 20x+ gap.
        // 3x catches that without flaking on ordinary jitter.
        expect(ratio).toBeLessThan(3);
    });
});
