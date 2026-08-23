const { createTokenIssuer } = require('../src/auth/token.issuer');
const { createTokenVerifier } = require('../src/http/middleware/token.verifier');

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256';
const issue = createTokenIssuer({ secret: SECRET, issuer: 'concize', audience: 'authenticated' });
const verify = createTokenVerifier({
    mode: 'hs256', jwtSecret: SECRET, issuer: 'concize', audience: 'authenticated',
});

describe('tokens this product issues', () => {
    it('are accepted by this product\'s own verifier', async () => {
        const { token } = await issue({ id: 'user-1', email: 'a@b.c' });
        const claims = await verify(token);
        expect(claims.sub).toBe('user-1');
        expect(claims.email).toBe('a@b.c');
    });

    it('carry the audience the verifier checks, or the gateway would reject them', async () => {
        const { token } = await issue({ id: 'user-1' });
        const claims = await verify(token);
        expect(claims.aud).toBe('authenticated');
        expect(claims.iss).toBe('concize');
    });

    it('expire', async () => {
        const { token } = await issue({ id: 'user-1' });
        const claims = await verify(token);
        expect(claims.exp).toBeGreaterThan(claims.iat);
    });

    it('are rejected by a verifier holding a different secret', async () => {
        const { token } = await issue({ id: 'user-1' });
        const other = createTokenVerifier({ mode: 'hs256', jwtSecret: 'a-completely-different-secret-value', audience: 'authenticated' });
        await expect(other(token)).rejects.toThrow();
    });

    it('refuse to mint without a subject, since ownership is keyed on it', async () => {
        await expect(issue({ email: 'a@b.c' })).rejects.toThrow(/user\.id/);
    });

    it('cannot be created without a secret', () => {
        expect(() => createTokenIssuer({ secret: '' })).toThrow(/secret/);
    });
});
