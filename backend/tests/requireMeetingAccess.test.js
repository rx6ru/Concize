// tests/requireMeetingAccess.test.js
// TDD for the ownership gate. This is the Tier-0 anchor:
//   user A requesting user B's meeting must get 404 and no data.

const { createRequireMeetingAccess } = require('../middlewares/requireMeetingAccess');

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
