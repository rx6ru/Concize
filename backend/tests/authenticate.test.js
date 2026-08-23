// tests/authenticate.test.js
// The authentication middleware accepts a Supabase JWT and nothing else.
// Legacy x-auth-code was removed in v4; the tests that guarded it are replaced by ones
// proving it is gone.

const { createAuthenticate } = require('../src/http/middleware/authenticate');
const { runWithContext, getContext } = require('../src/core/request.context');

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
            if (!next.mock.calls.length) resolve({ res, nexted: false });
        });
    });
}

describe('createAuthenticate', () => {
    const verifyAccessToken = jest.fn();
    const make = () => createAuthenticate({ verifyAccessToken });

    beforeEach(() => verifyAccessToken.mockReset());

    it('accepts a valid Bearer JWT and sets req.user from claims', async () => {
        verifyAccessToken.mockResolvedValue({ sub: 'user-99', email: 'x@y.z' });
        const req = { method: 'POST', headers: { authorization: 'Bearer good.token.here' } };
        const { res, nexted } = await run(make(), req);

        expect(nexted).toBe(true);
        expect(res.statusCode).toBeNull();
        expect(req.user).toEqual(expect.objectContaining({ id: 'user-99', email: 'x@y.z' }));
        expect(verifyAccessToken).toHaveBeenCalledWith('good.token.here');
    });

    it('rejects an invalid Bearer JWT with 401', async () => {
        verifyAccessToken.mockRejectedValue(new Error('bad signature'));
        const req = { method: 'POST', headers: { authorization: 'Bearer bad' } };
        const { res, nexted } = await run(make(), req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    it('rejects a request with no credentials at all', async () => {
        const req = { method: 'POST', headers: {} };
        const { res, nexted } = await run(make(), req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
        expect(verifyAccessToken).not.toHaveBeenCalled();
    });

    it('ignores x-auth-code entirely, however it is spelled', async () => {
        // The header used to be a way in. A request carrying it and nothing else must be refused
        // exactly like one carrying nothing.
        for (const headers of [
            { 'x-auth-code': 'lostnfound' },
            { 'X-Auth-Code': 'lostnfound' },
            { 'x-auth-code': '' },
        ]) {
            const req = { method: 'POST', headers };
            const { res, nexted } = await run(make(), req);
            expect(nexted).toBe(false);
            expect(res.statusCode).toBe(401);
        }
        expect(verifyAccessToken).not.toHaveBeenCalled();
    });

    it('does not fall back to any header when the JWT fails', async () => {
        verifyAccessToken.mockRejectedValue(new Error('expired'));
        const req = { method: 'POST', headers: { authorization: 'Bearer bad', 'x-auth-code': 'lostnfound' } };
        const { res, nexted } = await run(make(), req);

        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    it('lets a CORS preflight through, since it carries no credentials', async () => {
        const req = { method: 'OPTIONS', headers: {} };
        const { nexted } = await run(make(), req);
        expect(nexted).toBe(true);
    });

    it('accepts a JWT even when a stale x-auth-code is also present', async () => {
        verifyAccessToken.mockResolvedValue({ sub: 'user-1' });
        const req = { method: 'POST', headers: { authorization: 'Bearer good', 'x-auth-code': 'lostnfound' } };
        const { nexted } = await run(make(), req);
        expect(nexted).toBe(true);
        expect(req.user.id).toBe('user-1');
    });

    it('stamps the authenticated user id onto the per-request context', async () => {
        verifyAccessToken.mockResolvedValue({ sub: 'user-42' });
        const req = { method: 'POST', headers: { authorization: 'Bearer good' } };

        let userIdInContext;
        await runWithContext({}, async () => {
            await run(make(), req);
            userIdInContext = getContext().userId;
        });

        expect(userIdInContext).toBe('user-42');
    });

    it('leaves the context untouched when there is none to stamp', async () => {
        verifyAccessToken.mockResolvedValue({ sub: 'user-43' });
        const req = { method: 'POST', headers: { authorization: 'Bearer good' } };
        const { nexted } = await run(make(), req);
        expect(nexted).toBe(true);
        expect(getContext()).toBeUndefined();
    });
});
