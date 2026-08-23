// tests/requireMeetingAccess.test.js
// TDD for the ownership gate. This is the Tier-0 anchor:
//   user A requesting user B's meeting must get 404 and no data.

const { createRequireMeetingAccess, requireMeetingOwner } = require('../src/http/middleware/meeting.access');

function mockRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}
function run(middleware, req) {
    return new Promise((resolve) => {
        const res = mockRes();
        let nexted = false;
        const next = () => { nexted = true; resolve({ res, nexted, req }); };
        Promise.resolve(middleware(req, res, next)).then(() => {
            if (!nexted) resolve({ res, nexted, req });
        });
    });
}

describe('createRequireMeetingAccess', () => {
    const getMeetingOwner = jest.fn();
    const mw = createRequireMeetingAccess({ getMeetingOwner });

    beforeEach(() => getMeetingOwner.mockReset());

    it('ANCHOR: user A requesting user B\'s meeting gets 404 and no data', async () => {
        getMeetingOwner.mockResolvedValue('user-B');
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-A' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(404);
        expect(req.meeting).toBeUndefined();
        // Must not leak that the meeting exists.
        expect(JSON.stringify(res.body)).not.toMatch(/user-B/);
    });

    it('allows the owner through and attaches req.meeting', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-A' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(true);
        expect(res.statusCode).toBeNull();
        expect(req.meeting).toEqual({ meetingId: 'm-1', ownerId: 'user-A' });
    });

    it('returns 404 for a non-existent meeting (no existence leak)', async () => {
        getMeetingOwner.mockResolvedValue(null);
        const req = { params: { meetingId: 'ghost' }, user: { id: 'user-A' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(404);
    });

    it('returns 400 when meetingId is missing', async () => {
        const req = { params: {}, user: { id: 'user-A' } };
        const { res, nexted } = await run(mw, req);
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(400);
    });

    it('returns 401 when no authenticated user is present', async () => {
        const req = { params: { meetingId: 'm-1' } };
        const { res, nexted } = await run(mw, req);
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
        expect(getMeetingOwner).not.toHaveBeenCalled();
    });

    it('returns 500 when the ownership lookup throws', async () => {
        getMeetingOwner.mockRejectedValue(new Error('db down'));
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-A' } };
        const { res, nexted } = await run(mw, req);
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(500);
    });
});

describe('createRequireMeetingAccess with sharing', () => {
    const getMeetingOwner = jest.fn();
    const hasSharedAccess = jest.fn();
    const mw = createRequireMeetingAccess({ getMeetingOwner, hasSharedAccess });

    beforeEach(() => {
        getMeetingOwner.mockReset();
        hasSharedAccess.mockReset();
    });

    it('lets a reader the meeting was shared with through, ownerId stays the true owner', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        hasSharedAccess.mockResolvedValue(true);
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-B' } };
        const { res, nexted, req: doneReq } = await run(mw, req);

        expect(nexted).toBe(true);
        expect(res.statusCode).toBeNull();
        // ownerId is user-A (the real owner), never the caller: retrieval scoping depends on this.
        expect(doneReq.meeting).toEqual({ meetingId: 'm-1', ownerId: 'user-A' });
        expect(hasSharedAccess).toHaveBeenCalledWith('m-1', 'user-B');
    });

    it('ANCHOR: a reader with no grant still gets 404, not the share check bypassed', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        hasSharedAccess.mockResolvedValue(false);
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-B' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/user-A/);
    });

    it('does not consult the share table for a non-existent meeting', async () => {
        getMeetingOwner.mockResolvedValue(null);
        const req = { params: { meetingId: 'ghost' }, user: { id: 'user-B' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(404);
        expect(hasSharedAccess).not.toHaveBeenCalled();
    });

    it('returns 500 when the share lookup throws, rather than silently denying or admitting', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        hasSharedAccess.mockRejectedValue(new Error('db down'));
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-B' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(500);
    });

    it('the owner is admitted without ever consulting the share table', async () => {
        getMeetingOwner.mockResolvedValue('user-A');
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-A' } };
        const { nexted } = await run(mw, req);

        expect(nexted).toBe(true);
        expect(hasSharedAccess).not.toHaveBeenCalled();
    });
});

describe('createRequireMeetingAccess without a hasSharedAccess dependency (backward compat)', () => {
    it('behaves exactly as owner-only when no sharing dependency is injected', async () => {
        const getMeetingOwner = jest.fn().mockResolvedValue('user-A');
        const mw = createRequireMeetingAccess({ getMeetingOwner });
        const req = { params: { meetingId: 'm-1' }, user: { id: 'user-B' } };
        const { res, nexted } = await run(mw, req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(404);
    });
});

describe('requireMeetingOwner', () => {
    it('lets the owner through', () => {
        const req = { meeting: { meetingId: 'm-1', ownerId: 'user-A' }, user: { id: 'user-A' } };
        const res = mockRes();
        const next = jest.fn();
        requireMeetingOwner(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBeNull();
    });

    it('blocks a shared reader with 403, not 404, since they already know the meeting exists', () => {
        const req = { meeting: { meetingId: 'm-1', ownerId: 'user-A' }, user: { id: 'user-B' } };
        const res = mockRes();
        const next = jest.fn();
        requireMeetingOwner(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });
});
