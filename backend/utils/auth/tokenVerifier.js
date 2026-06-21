// utils/auth/tokenVerifier.js
//
// Thin, injectable access-token verifier seam, built on `jose` — the library Supabase
// officially recommends for backend JWT verification (it natively supports ES256, which is
// Supabase's default asymmetric algorithm, plus RS256, and handles JWKS fetch/cache/rotation).
//
// The rest of the app depends only on the returned `verifyAccessToken(token) -> claims`
// function, never on Supabase or jose directly. Identity stays swappable; the crypto path
// is unit-testable by injecting a local JWKS (jose `createLocalJWKSet`) instead of a network call.
//
// Grounding (Supabase docs, 2026):
//   JWKS:     https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
//   issuer:   https://<ref>.supabase.co/auth/v1
//   audience: authenticated
//   user id:  `sub` claim; email is a top-level claim
//   NOTE: local JWKS verification checks signature + expiry only, NOT server-side session
//         revocation. Acceptable for this tier; revisit if immediate logout enforcement is needed.

const jose = require('jose');

/**
 * @param {Object} opts
 * @param {'jwks'|'hs256'} [opts.mode='jwks'] Verification strategy.
 * @param {string} [opts.jwksUri] JWKS endpoint (required for jwks mode unless `jwks` injected).
 * @param {string} [opts.jwtSecret] Shared secret (required for hs256 mode).
 * @param {string} [opts.issuer] Expected `iss` claim — enforced by jose.
 * @param {string|string[]} [opts.audience] Expected `aud` claim (Supabase: 'authenticated').
 * @param {Function} [opts.jwks] Test/override hook: a jose key-resolver (e.g. from createLocalJWKSet).
 * @returns {(token: string) => Promise<object>} verifyAccessToken — resolves claims or rejects.
 */
function createTokenVerifier(opts = {}) {
    const { mode = 'jwks', jwksUri, jwtSecret, issuer, audience } = opts;

    const verifyOptions = {};
    if (issuer) verifyOptions.issuer = issuer;
    if (audience) verifyOptions.audience = audience;

    const injectedJwks = opts.jwks || null;
    let remoteJwks = null;

    return async function verifyAccessToken(token) {
        if (!token || typeof token !== 'string') {
            throw new Error('No token provided');
        }

        if (mode === 'hs256') {
            if (!jwtSecret) throw new Error('tokenVerifier: jwtSecret is required in hs256 mode');
            const secret = new TextEncoder().encode(jwtSecret);
            const { payload } = await jose.jwtVerify(token, secret, {
                algorithms: ['HS256'],
                ...verifyOptions,
            });
            return payload;
        }

        // Asymmetric / JWKS (default). jose resolves the right key by the token's `kid`
        // and transparently handles multi-key rotation windows.
        let keySet = injectedJwks;
        if (!keySet) {
            if (!jwksUri) {
                throw new Error('tokenVerifier: jwksUri is required in jwks mode (or inject jwks)');
            }
            keySet = remoteJwks ||= jose.createRemoteJWKSet(new URL(jwksUri));
        }
        const { payload } = await jose.jwtVerify(token, keySet, {
            algorithms: ['ES256', 'RS256'],
            ...verifyOptions,
        });
        return payload;
    };
}

module.exports = { createTokenVerifier };
