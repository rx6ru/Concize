// tests/legacyRoutesOwnership.test.js
// The legacy (compat-shim) routes must enforce the SAME ownership rule as the RESTful routes:
// a caller may not read/write another tenant's meeting via cookie/body jobId. Cross-tenant → 404.

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

jest.mock('../db/mongoutils/transcription.db', () => ({
    getMeetingOwner: jest.fn(),
    getTranscription: jest.fn(),
    createTranscription: jest.fn(),
}));
jest.mock('../db/mongoutils/summary.db', () => ({ getMeetingSummary: jest.fn() }));
jest.mock('../controllers/chatLLM', () => ({ getLLMStreamResponse: jest.fn((res) => res.json({ ok: true })) }));

const { getMeetingOwner, getTranscription } = require('../db/mongoutils/transcription.db');
const { getMeetingSummary } = require('../db/mongoutils/summary.db');

const transcRoutes = require('../routes/v1/transcRoutes');
const meetingRoutes = require('../routes/v1/meetingRoutes');
const chatRoutes = require('../routes/v1/chatRoutes');

let currentUser;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => { req.user = currentUser; next(); });
app.use('/api/v1/transcription', transcRoutes);
app.use('/api/v1/meeting', meetingRoutes);
app.use('/api/v1/chat', chatRoutes);

describe('legacy routes enforce ownership', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'user-A' };
        getMeetingOwner.mockResolvedValue('user-B'); // the meeting belongs to someone else
    });

    it('GET /transcription with another tenant\'s jobId cookie → 404, no data', async () => {
        getTranscription.mockResolvedValue({ transcriptionChunks: ['secret'] });
        const res = await request(app).get('/api/v1/transcription').set('Cookie', 'jobId=meeting-B');
        expect(res.status).toBe(404);
        expect(getTranscription).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toMatch(/secret/);
    });

    it('GET /meeting/:jobId/summary for another tenant → 404', async () => {
        getMeetingSummary.mockResolvedValue({ title: 'B title', content: 'B secret' });
        const res = await request(app).get('/api/v1/meeting/meeting-B/summary');
        expect(res.status).toBe(404);
        expect(getMeetingSummary).not.toHaveBeenCalled();
    });

    it('POST /chat/stream with another tenant\'s jobId in body → 404', async () => {
        const res = await request(app)
            .post('/api/v1/chat/stream')
            .send({ userPrompt: 'hi', jobId: 'meeting-B' });
        expect(res.status).toBe(404);
    });

    it('allows the owner through (sanity)', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        getTranscription.mockResolvedValue({ transcriptionChunks: ['mine'] });
        const res = await request(app).get('/api/v1/transcription').set('Cookie', 'jobId=meeting-A');
        expect(res.status).toBe(200);
        expect(res.body.transcriptionChunks).toEqual(['mine']);
    });
});
