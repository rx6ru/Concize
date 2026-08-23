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
jest.mock('../src/meetings/meeting.share.repository', () => ({
    isSharedWith: jest.fn(),
    grantShare: jest.fn(),
    revokeShare: jest.fn(),
    listShares: jest.fn(),
    listSharedMeetings: jest.fn(),
}));
jest.mock('../src/auth/user.repository', () => ({ findUserByEmail: jest.fn() }));
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
const {
    isSharedWith, grantShare, revokeShare, listShares, listSharedMeetings,
} = require('../src/meetings/meeting.share.repository');
const { findUserByEmail } = require('../src/auth/user.repository');
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

// jest.clearAllMocks() (used throughout this file) clears call history but not a mock's
// configured implementation, so a mockResolvedValue set by an earlier test would otherwise
// leak forward. Every test that cares about sharing sets this explicitly; this is just the
// default for the tests that don't.
beforeEach(() => { isSharedWith.mockResolvedValue(false); });

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
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'user-A' };
        listSharedMeetings.mockResolvedValue([]);
    });

    it('returns only the caller\'s own meetings', async () => {
        listMeetings.mockResolvedValue([
            { meetingId: 'm1', status: 'completed', createdAt: '2026-08-09T10:00:00Z', title: 'Q3' },
        ]);

        const res = await request(app).get('/api/v1/meetings');

        expect(res.status).toBe(200);
        expect(res.body.meetings).toHaveLength(1);
        expect(res.body.meetings[0]).toMatchObject({ meetingId: 'm1', shared: false });
        // scoped in the query, not filtered afterwards
        expect(listMeetings).toHaveBeenCalledWith('user-A', expect.anything());
    });

    it('rejects an unauthenticated caller', async () => {
        currentUser = undefined;
        const res = await request(app).get('/api/v1/meetings');
        expect(res.status).toBe(401);
        expect(listMeetings).not.toHaveBeenCalled();
    });

    it('includes meetings shared with the caller, marked distinct from their own', async () => {
        listMeetings.mockResolvedValue([
            { meetingId: 'own-1', status: 'completed', createdAt: '2026-08-09T10:00:00Z', title: 'Mine' },
        ]);
        listSharedMeetings.mockResolvedValue([
            { meetingId: 'shared-1', status: 'completed', createdAt: '2026-08-10T10:00:00Z', title: 'Theirs' },
        ]);

        const res = await request(app).get('/api/v1/meetings');

        expect(res.status).toBe(200);
        expect(listSharedMeetings).toHaveBeenCalledWith('user-A', expect.anything());
        const byId = Object.fromEntries(res.body.meetings.map((m) => [m.meetingId, m]));
        expect(byId['own-1'].shared).toBe(false);
        expect(byId['shared-1'].shared).toBe(true);
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

    it('ANCHOR: a shared reader cannot delete the meeting', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        isSharedWith.mockResolvedValue(true);
        currentUser = { id: 'reader-B' };

        const res = await request(app).delete('/api/v1/meetings/m1');

        expect(res.status).toBe(403);
        expect(purgeMeeting).not.toHaveBeenCalled();
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

describe('sharing: what a shared reader can and cannot do', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'reader-B' };
        getMeetingOwner.mockResolvedValue('owner-A');
        rateLimitState.blocked = {};
    });

    it('ANCHOR: a reader the meeting was shared with can read it', async () => {
        isSharedWith.mockResolvedValue(true);
        getTranscription.mockResolvedValue({ transcriptionChunks: ['hello'] });

        const res = await request(app).get('/api/v1/meetings/m1/transcript');

        expect(res.status).toBe(200);
        expect(res.body.transcriptionChunks).toEqual(['hello']);
    });

    it('ANCHOR: a reader the meeting was NOT shared with gets 404, same as a stranger', async () => {
        isSharedWith.mockResolvedValue(false);

        const res = await request(app).get('/api/v1/meetings/m1/transcript');

        expect(res.status).toBe(404);
        expect(getTranscription).not.toHaveBeenCalled();
    });

    it('a shared reader can chat about the meeting', async () => {
        isSharedWith.mockResolvedValue(true);
        const { getLLMStreamResponse } = require('../src/chat/chat.controller');
        getLLMStreamResponse.mockImplementation(async (res) => { res.status(200).end(); });

        const res = await request(app)
            .post('/api/v1/meetings/m1/chat')
            .send({ userPrompt: 'what did we decide?' });

        expect(res.status).toBe(200);
        // ownerId passed through is the true owner, not the reader: retrieval is keyed on it.
        expect(getLLMStreamResponse).toHaveBeenCalledWith(
            expect.anything(), 'what did we decide?', 'm1', 'owner-A');
    });

    it('a shared reader cannot rename a speaker', async () => {
        isSharedWith.mockResolvedValue(true);

        const res = await request(app)
            .put('/api/v1/meetings/m1/speakers/S1')
            .send({ name: 'Priya' });

        expect(res.status).toBe(403);
    });

    it('ANCHOR: a shared reader cannot re-share the meeting', async () => {
        isSharedWith.mockResolvedValue(true);

        const res = await request(app)
            .post('/api/v1/meetings/m1/shares')
            .send({ email: 'someone@example.com' });

        expect(res.status).toBe(403);
        expect(grantShare).not.toHaveBeenCalled();
    });

    it('ANCHOR: a shared reader cannot grant themselves (or anyone) anything, cannot revoke, cannot list', async () => {
        isSharedWith.mockResolvedValue(true);

        const grant = await request(app).post('/api/v1/meetings/m1/shares').send({ email: 'reader-B@example.com' });
        const revoke = await request(app).delete('/api/v1/meetings/m1/shares/some-share-id');
        const list = await request(app).get('/api/v1/meetings/m1/shares');

        expect(grant.status).toBe(403);
        expect(revoke.status).toBe(403);
        expect(list.status).toBe(403);
        expect(grantShare).not.toHaveBeenCalled();
        expect(revokeShare).not.toHaveBeenCalled();
        expect(listShares).not.toHaveBeenCalled();
    });
});

describe('sharing: owner-only management routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentUser = { id: 'owner-A' };
        getMeetingOwner.mockResolvedValue('owner-A');
    });

    it('grants access to an email that has an account', async () => {
        findUserByEmail.mockResolvedValue({ id: 'reader-B', email: 'reader@example.com' });
        grantShare.mockResolvedValue({ id: 'share-1', meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        const res = await request(app).post('/api/v1/meetings/m1/shares').send({ email: 'reader@example.com' });

        expect(res.status).toBe(202);
        expect(grantShare).toHaveBeenCalledWith({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
    });

    it('does not reveal whether an unknown email has an account: same response, no share created', async () => {
        findUserByEmail.mockResolvedValue(null);

        const res = await request(app).post('/api/v1/meetings/m1/shares').send({ email: 'unknown@example.com' });

        expect(res.status).toBe(202);
        expect(grantShare).not.toHaveBeenCalled();
    });

    it('the response body is identical whether or not the email matched an account', async () => {
        findUserByEmail.mockResolvedValueOnce({ id: 'reader-B', email: 'reader@example.com' });
        grantShare.mockResolvedValue({ id: 'share-1' });
        const foundRes = await request(app).post('/api/v1/meetings/m1/shares').send({ email: 'reader@example.com' });

        findUserByEmail.mockResolvedValueOnce(null);
        const notFoundRes = await request(app).post('/api/v1/meetings/m1/shares').send({ email: 'ghost@example.com' });

        expect(foundRes.status).toBe(notFoundRes.status);
        expect(foundRes.body).toEqual(notFoundRes.body);
    });

    it('rejects a malformed email before touching the lookup', async () => {
        const res = await request(app).post('/api/v1/meetings/m1/shares').send({ email: 'not-an-email' });

        expect(res.status).toBe(400);
        expect(findUserByEmail).not.toHaveBeenCalled();
    });

    it('ANCHOR: revoking removes access — a subsequent request from that reader is denied', async () => {
        revokeShare.mockResolvedValue(true);
        const revokeRes = await request(app).delete('/api/v1/meetings/m1/shares/share-1');
        expect(revokeRes.status).toBe(204);
        expect(revokeShare).toHaveBeenCalledWith('m1', 'share-1');

        // The revoked reader's next request is checked fresh against the share table; simulate
        // the post-revocation state and confirm the gate now denies them.
        currentUser = { id: 'reader-B' };
        isSharedWith.mockResolvedValue(false);
        const readRes = await request(app).get('/api/v1/meetings/m1/transcript');
        expect(readRes.status).toBe(404);
    });

    it('reports 404 when revoking a share id that does not exist', async () => {
        revokeShare.mockResolvedValue(false);
        const res = await request(app).delete('/api/v1/meetings/m1/shares/no-such-share');
        expect(res.status).toBe(404);
    });

    it('lists who the meeting is shared with', async () => {
        listShares.mockResolvedValue([
            { id: 'share-1', userId: 'reader-B', email: 'reader@example.com', createdAt: '2026-08-20T00:00:00Z' },
        ]);

        const res = await request(app).get('/api/v1/meetings/m1/shares');

        expect(res.status).toBe(200);
        expect(res.body.shares).toHaveLength(1);
        expect(listShares).toHaveBeenCalledWith('m1');
    });
});
