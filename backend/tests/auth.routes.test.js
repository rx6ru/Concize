jest.mock('../src/auth/user.repository', () => ({
    createUser: jest.fn(),
    findUserByEmail: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const { createUser, findUserByEmail } = require('../src/auth/user.repository');
const { hashPassword } = require('../src/auth/password');

process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-long-enough-for-hs256';
const authRoutes = require('../src/http/routes/v1/auth.routes');

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRoutes);

beforeEach(() => jest.clearAllMocks());

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
