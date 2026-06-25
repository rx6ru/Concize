// tests/meetingsRoutes.test.js
// End-to-end ownership enforcement through the REAL RESTful meetings router
// (authenticate is stubbed to inject req.user; the DB layer is mocked).
// This proves the wiring — not just the middleware in isolation — denies cross-tenant access.

const request = require('supertest');
const express = require('express');

// Mock the DB module BEFORE requiring anything that binds to it (middlewares/auth captures
// getMeetingOwner at load time; the mock must be in place first).
jest.mock('../src/meetings/meeting.repository', () => ({
    getMeetingOwner: jest.fn(),
    getTranscription: jest.fn(),
    createTranscription: jest.fn(),
}));
// Avoid pulling the chat/LLM stack into this test.
jest.mock('../src/chat/chat.controller', () => ({ getLLMStreamResponse: jest.fn() }));

const { getMeetingOwner, getTranscription } = require('../src/meetings/meeting.repository');
const meetingsRoutes = require('../src/http/routes/v1/meeting.routes');

// Build an app with a controllable stub user.
let currentUser;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = currentUser; next(); });
app.use('/api/v1/meetings', meetingsRoutes);

describe('RESTful /meetings ownership (end-to-end)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'user-A' };
    });

    it('ANCHOR: user A cannot read user B\'s transcript → 404, no data', async () => {
        getMeetingOwner.mockResolvedValue('user-B');
        getTranscription.mockResolvedValue({ transcriptionChunks: ['secret content'] });

        const res = await request(app).get('/api/v1/meetings/meeting-1/transcript');

        expect(res.status).toBe(404);
        expect(getTranscription).not.toHaveBeenCalled(); // gate blocks before any data read
        expect(JSON.stringify(res.body)).not.toMatch(/secret content/);
        expect(JSON.stringify(res.body)).not.toMatch(/user-B/);
    });

    it('owner can read their own transcript → 200 with data', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        getTranscription.mockResolvedValue({ transcriptionChunks: ['my content'] });

        const res = await request(app).get('/api/v1/meetings/meeting-1/transcript');

        expect(res.status).toBe(200);
        expect(res.body.transcriptionChunks).toEqual(['my content']);
        expect(getTranscription).toHaveBeenCalledWith('meeting-1');
    });

    it('unknown meeting → 404 (no existence leak)', async () => {
        getMeetingOwner.mockResolvedValue(null);
        const res = await request(app).get('/api/v1/meetings/ghost/transcript');
        expect(res.status).toBe(404);
    });
});
