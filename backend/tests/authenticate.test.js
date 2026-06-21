// tests/authenticate.test.js
// TDD for the dual-mode authentication middleware.
// Verifies: Bearer-JWT happy path, invalid-JWT rejection (no fallthrough),
// legacy x-auth-code behind a flag (mapped to a synthetic ownerId), and hard denial.

const { createAuthenticate } = require('../middlewares/authenticate');

// Minimal Express req/res/next doubles.
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
        const next = jest.fn(() => resolve({ res, nexted: true }));
        Promise.resolve(middleware(req, res, () => next())).then(() => {
            // If next wasn't called, resolve with the response that was sent.
            if (!next.mock.calls.length) resolve({ res, nexted: false });
        });
    });
}

describe('createAuthenticate', () => {
    const SYNTHETIC = 'legacy-owner-id';

    const verifyAccessToken = jest.fn();
    const make = (legacyEnabled = true) => createAuthenticate({
        verifyAccessToken,
        legacy: { enabled: legacyEnabled, codes: ['lostnfound'], ownerId: SYNTHETIC },
    });

    beforeEach(() => verifyAccessToken.mockReset());

    it('accepts a valid Bearer JWT and sets req.user from claims', async () => {
        verifyAccessToken.mockResolvedValue({ sub: 'user-99', email: 'x@y.z' });
        const req = { method: 'POST', headers: { authorization: 'Bearer good.token.here' } };
        const { res, nexted } = await run(make(), req);

        expect(nexted).toBe(true);
        expect(res.statusCode).toBeNull();
        expect(req.user).toEqual(expect.objectContaining({ id: 'user-99', email: 'x@y.z', mode: 'jwt' }));
        expect(verifyAccessToken).toHaveBeenCalledWith('good.token.here');
    });

    it('rejects an invalid Bearer JWT with 401 and does NOT fall back to legacy', async () => {
        verifyAccessToken.mockRejectedValue(new Error('bad signature'));
        const req = { method: 'POST', headers: { authorization: 'Bearer bad', 'x-auth-code': 'lostnfound' } };
        const { res, nexted } = await run(make(), req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
        expect(req.user).toBeUndefined();
    });

    it('accepts a legacy x-auth-code (flag on) and maps it to the synthetic ownerId', async () => {
        const req = { method: 'POST', headers: { 'x-auth-code': 'lostnfound' } };
        const { res, nexted } = await run(make(true), req);

        expect(nexted).toBe(true);
        expect(req.user).toEqual(expect.objectContaining({ id: SYNTHETIC, mode: 'legacy' }));
        expect(verifyAccessToken).not.toHaveBeenCalled();
    });

    it('rejects a legacy x-auth-code when the legacy flag is off', async () => {
        const req = { method: 'POST', headers: { 'x-auth-code': 'lostnfound' } };
        const { res, nexted } = await run(make(false), req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    it('rejects a wrong legacy code', async () => {
        const req = { method: 'POST', headers: { 'x-auth-code': 'wrong' } };
        const { res, nexted } = await run(make(true), req);
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    it('rejects when no credentials are provided at all', async () => {
        const req = { method: 'POST', headers: {} };
        const { res, nexted } = await run(make(true), req);
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    it('lets CORS preflight (OPTIONS) through without auth', async () => {
        const req = { method: 'OPTIONS', headers: {} };
        const { nexted } = await run(make(true), req);
        expect(nexted).toBe(true);
    });
});
