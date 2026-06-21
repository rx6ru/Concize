// tests/tokenVerifier.test.js
// TDD for the injectable access-token verifier seam, exercising the REAL jose crypto path.
// The JWKS mode is tested with ES256 (Supabase's default asymmetric algorithm) via an
// injected local JWKS — no live Supabase needed, but the actual signature verification runs.

const { createTokenVerifier } = require('../utils/auth/tokenVerifier');

const jose = require('jose');

const ISS = 'https://abcdefgh.supabase.co/auth/v1';
const AUD = 'authenticated';

describe('createTokenVerifier', () => {
    describe('jwks (asymmetric, ES256) mode — Supabase default', () => {
        let priv, localJwks, verify, kid;

        beforeAll(async () => {
            kid = 'kid-es256-1';
            const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
            priv = privateKey;
            const jwk = await jose.exportJWK(publicKey);
            jwk.kid = kid;
            jwk.alg = 'ES256';
            localJwks = jose.createLocalJWKSet({ keys: [jwk] });
            verify = createTokenVerifier({ mode: 'jwks', jwks: localJwks, issuer: ISS, audience: AUD });
        });

        const sign = (claims, opts = {}) =>
            new jose.SignJWT(claims)
                .setProtectedHeader({ alg: 'ES256', kid })
                .setIssuer(opts.iss ?? ISS)
                .setAudience(opts.aud ?? AUD)
                .setExpirationTime(opts.exp ?? '2h')
                .setIssuedAt()
                .sign(priv);

        it('verifies a valid ES256 token and returns claims (sub, email)', async () => {
            const token = await sign({ sub: 'user-uuid-1', email: 'a@b.c', role: 'authenticated' });
            const claims = await verify(token);
            expect(claims.sub).toBe('user-uuid-1');
            expect(claims.email).toBe('a@b.c');
        });

        it('rejects a token signed by a different key', async () => {
            const other = await jose.generateKeyPair('ES256', { extractable: true });
            const token = await new jose.SignJWT({ sub: 'x' })
                .setProtectedHeader({ alg: 'ES256', kid })
                .setIssuer(ISS).setAudience(AUD).setExpirationTime('2h').setIssuedAt()
                .sign(other.privateKey);
            await expect(verify(token)).rejects.toThrow();
        });

        it('rejects an expired token', async () => {
            const token = await sign({ sub: 'u' }, { exp: '-10s' });
            await expect(verify(token)).rejects.toThrow();
        });

        it('rejects a wrong issuer', async () => {
            const token = await sign({ sub: 'u' }, { iss: 'https://evil.example/auth/v1' });
            await expect(verify(token)).rejects.toThrow();
        });

        it('rejects a wrong audience', async () => {
            const token = await sign({ sub: 'u' }, { aud: 'anon' });
            await expect(verify(token)).rejects.toThrow();
        });

        it('rejects an empty/missing token', async () => {
            await expect(verify('')).rejects.toThrow();
            await expect(verify(undefined)).rejects.toThrow();
        });
    });

    describe('hs256 mode — legacy fallback', () => {
        const secret = 'test-shared-secret-at-least-32-bytes-long!!';
        let verify;
        beforeAll(() => { verify = createTokenVerifier({ mode: 'hs256', jwtSecret: secret, issuer: ISS, audience: AUD }); });

        const sign = (claims, opts = {}) =>
            new jose.SignJWT(claims)
                .setProtectedHeader({ alg: 'HS256' })
                .setIssuer(ISS).setAudience(AUD)
                .setExpirationTime(opts.exp ?? '2h').setIssuedAt()
                .sign(new TextEncoder().encode(secret));

        it('verifies a valid HS256 token', async () => {
            const token = await sign({ sub: 'user-1' });
            const claims = await verify(token);
            expect(claims.sub).toBe('user-1');
        });

        it('rejects a token signed with the wrong secret', async () => {
            const token = await new jose.SignJWT({ sub: 'u' })
                .setProtectedHeader({ alg: 'HS256' })
                .setIssuer(ISS).setAudience(AUD).setExpirationTime('2h').setIssuedAt()
                .sign(new TextEncoder().encode('the-wrong-secret-padded-to-32-bytes!!!!'));
            await expect(verify(token)).rejects.toThrow();
        });
    });
});
