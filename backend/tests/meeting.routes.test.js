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
jest.mock('../src/transcript/utterance.repository', () => ({ getTranscript: jest.fn() }));
jest.mock('../src/infra/postgres', () => ({ query: jest.fn() }));
jest.mock('../src/transcript/speaker.names', () => ({
    namesFor: jest.fn().mockResolvedValue(new Map()),
    setName: jest.fn(),
    displayFor: (names, label) => (names && names.get(label)) || label,
}));
// Real rate limiting (Redis) is exercised in tests/rate.limit.test.js. Here the limiter is a
// controllable pass-through, so this file can prove it is actually mounted on the real router,
// in the real order, without hitting Redis.
jest.mock('../src/http/middleware/rate.limit', () => {
    const state = { blocked: {} };
    return {
        __state: state,
        createRateLimiter: jest.fn(({ name }) => (req, res, next) => {
            if (state.blocked[name]) {
                return res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS' } });
            }
            return next();
        }),
    };
});

const { getMeetingOwner, getTranscription, listMeetings, createTranscription } = require('../src/meetings/meeting.repository');
const { purgeMeeting } = require('../src/meetings/meeting.purge.wiring');
const { getTranscript } = require('../src/transcript/utterance.repository');
const { namesFor, setName } = require('../src/transcript/speaker.names');
const { query } = require('../src/infra/postgres');
const { __state: rateLimitState } = require('../src/http/middleware/rate.limit');
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

describe('utterances', () => {
    beforeEach(() => { jest.clearAllMocks(); currentUser = { id: 'user-A' }; });

    it('returns speaker-attributed turns with a cursor for the next page', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        getTranscript.mockResolvedValue([
            { turnId: 't1', seq: 0, t0Ms: 0, t1Ms: 900, text: 'hello', speakerLabel: 'S1', speakerConfidence: 'confident', overlap: false, overlapRatio: 0 },
            { turnId: 't2', seq: 1, t0Ms: 1000, t1Ms: 1900, text: 'hi', speakerLabel: 'S2', speakerConfidence: 'provisional', overlap: false, overlapRatio: 0 },
        ]);

        const res = await request(app).get('/api/v1/meetings/m1/utterances?limit=2');

        expect(res.status).toBe(200);
        expect(res.body.utterances).toHaveLength(2);
        expect(res.body.utterances[0].speaker).toBe('S1');
        expect(res.body.nextCursor).toBe(1);
    });

    it('reports no further pages at the end', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        getTranscript.mockResolvedValue([]);

        const res = await request(app).get('/api/v1/meetings/m1/utterances');

        expect(res.body.utterances).toEqual([]);
        expect(res.body.nextCursor).toBeNull();
    });

    it('will not serve someone else\'s transcript', async () => {
        getMeetingOwner.mockResolvedValue('user-B');

        const res = await request(app).get('/api/v1/meetings/m1/utterances');

        expect(res.status).toBe(404);
        expect(getTranscript).not.toHaveBeenCalled();
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

describe('speaker names', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'user-A' };
        namesFor.mockResolvedValue(new Map());
    });

    it('renders a named speaker while keeping the label to group by', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        namesFor.mockResolvedValue(new Map([['S1', 'Priya']]));
        getTranscript.mockResolvedValue([
            { turnId: 't1', seq: 0, t0Ms: 0, t1Ms: 900, text: 'hello', speakerLabel: 'S1', speakerConfidence: 'confident', overlap: false, overlapRatio: 0 },
        ]);

        const res = await request(app).get('/api/v1/meetings/m1/utterances');

        expect(res.body.utterances[0].speaker).toBe('S1');
        expect(res.body.utterances[0].speakerName).toBe('Priya');
    });

    it('falls back to the label for an unnamed speaker', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        getTranscript.mockResolvedValue([
            { turnId: 't1', seq: 0, t0Ms: 0, t1Ms: 900, text: 'hello', speakerLabel: 'S4', speakerConfidence: 'confident', overlap: false, overlapRatio: 0 },
        ]);

        const res = await request(app).get('/api/v1/meetings/m1/utterances');
        expect(res.body.utterances[0].speakerName).toBe('S4');
    });

    it('still serves the transcript when the naming lookup fails', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        namesFor.mockRejectedValue(new Error('db down'));
        getTranscript.mockResolvedValue([
            { turnId: 't1', seq: 0, t0Ms: 0, t1Ms: 900, text: 'hello', speakerLabel: 'S1', speakerConfidence: 'confident', overlap: false, overlapRatio: 0 },
        ]);

        const res = await request(app).get('/api/v1/meetings/m1/utterances');

        expect(res.status).toBe(200);
        expect(res.body.utterances[0].speakerName).toBe('S1');
    });

    it('lists every speaker in the meeting, named or not', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        namesFor.mockResolvedValue(new Map([['S1', 'Priya']]));
        query.mockResolvedValue({ rows: [{ speaker_label: 'S1' }, { speaker_label: 'S2' }] });

        const res = await request(app).get('/api/v1/meetings/m1/speakers');

        expect(res.status).toBe(200);
        expect(res.body.speakers).toEqual([
            { label: 'S1', name: 'Priya' },
            { label: 'S2', name: null },
        ]);
    });

    it('names a speaker', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        setName.mockResolvedValue('Priya');

        const res = await request(app)
            .put('/api/v1/meetings/m1/speakers/S1')
            .send({ name: 'Priya' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ label: 'S1', name: 'Priya' });
        expect(setName).toHaveBeenCalledWith('m1', 'S1', 'Priya');
    });

    it('will not name a speaker in someone else\'s meeting', async () => {
        getMeetingOwner.mockResolvedValue('user-B');

        const res = await request(app)
            .put('/api/v1/meetings/m1/speakers/S1')
            .send({ name: 'Priya' });

        expect(res.status).toBe(404);
        expect(setName).not.toHaveBeenCalled();
    });
});

describe('rate limiting wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'user-A' };
        rateLimitState.blocked = {};
    });

    it('a tripped meeting-creation limiter stops the request before the handler runs', async () => {
        rateLimitState.blocked['meeting-create'] = true;
        createTranscription.mockResolvedValue({ meetingId: 'm1' });

        const res = await request(app).post('/api/v1/meetings');

        expect(res.status).toBe(429);
        expect(createTranscription).not.toHaveBeenCalled();
    });

    it('an untripped limiter lets meeting creation through as normal', async () => {
        createTranscription.mockResolvedValue({ meetingId: 'm1' });

        const res = await request(app).post('/api/v1/meetings');

        expect(res.status).toBe(201);
        expect(createTranscription).toHaveBeenCalled();
    });

    it('a tripped chat limiter stops the request before ownership is even checked', async () => {
        rateLimitState.blocked.chat = true;

        const res = await request(app)
            .post('/api/v1/meetings/m1/chat')
            .send({ userPrompt: 'what did we decide?' });

        expect(res.status).toBe(429);
        expect(getMeetingOwner).not.toHaveBeenCalled();
    });
});
