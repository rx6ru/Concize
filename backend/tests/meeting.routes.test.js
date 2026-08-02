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
    listMeetings: jest.fn(),
    deleteMeeting: jest.fn(),
}));
// Avoid pulling the chat/LLM stack into this test.
jest.mock('../src/chat/chat.controller', () => ({ getLLMStreamResponse: jest.fn() }));
// Vector purge reaches Qdrant; the composition is tested in meeting.purge.test.js.
jest.mock('../src/meetings/meeting.purge.wiring', () => ({ purgeMeeting: jest.fn() }));

const { getMeetingOwner, getTranscription, listMeetings } = require('../src/meetings/meeting.repository');
const { purgeMeeting } = require('../src/meetings/meeting.purge.wiring');
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

describe('listing meetings', () => {
    beforeEach(() => { jest.clearAllMocks(); currentUser = { id: 'user-A' }; });

    it('returns only the caller\'s own meetings', async () => {
        listMeetings.mockResolvedValue([
            { meetingId: 'm1', status: 'completed', createdAt: '2026-08-09T10:00:00Z', title: 'Q3' },
        ]);

        const res = await request(app).get('/api/v1/meetings');

        expect(res.status).toBe(200);
        expect(res.body.meetings).toHaveLength(1);
        // scoped in the query, not filtered afterwards
        expect(listMeetings).toHaveBeenCalledWith('user-A', expect.anything());
    });

    it('rejects an unauthenticated caller', async () => {
        currentUser = undefined;
        const res = await request(app).get('/api/v1/meetings');
        expect(res.status).toBe(401);
        expect(listMeetings).not.toHaveBeenCalled();
    });
});

describe('deleting a meeting', () => {
    beforeEach(() => { jest.clearAllMocks(); currentUser = { id: 'user-A' }; });

    it('deletes a meeting the caller owns', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        purgeMeeting.mockResolvedValue({ deleted: true });

        const res = await request(app).delete('/api/v1/meetings/m1');

        expect(res.status).toBe(204);
        expect(purgeMeeting).toHaveBeenCalledWith('m1');
    });

    // The whole point of the gate: deletion is the most destructive thing here.
    it('will not delete someone else\'s meeting', async () => {
        getMeetingOwner.mockResolvedValue('user-B');

        const res = await request(app).delete('/api/v1/meetings/m1');

        expect(res.status).toBe(404);
        expect(purgeMeeting).not.toHaveBeenCalled();
    });

    it('reports failure rather than a false success when the vector store is down', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        purgeMeeting.mockRejectedValue(new Error('qdrant down'));

        const res = await request(app).delete('/api/v1/meetings/m1');

        expect(res.status).toBe(500);
    });
});
