// Injectable access-token verifier. The rest of the app depends only on the returned verifyAccessToken(token) -> claims, never on Supabase or jose directly, so identity stays swappable and the crypto path is unit-testable via an injected local JWKS.
// Local JWKS verification checks signature + expiry only, not server-side session revocation.

const jose = require('jose');

/**
 * @param {Object} opts
 * @param {'jwks'|'hs256'} [opts.mode='jwks']
 * @param {string} [opts.jwksUri] required for jwks mode unless opts.jwks is injected
 * @param {string} [opts.jwtSecret] required for hs256 mode
 * @param {string} [opts.issuer]
 * @param {string|string[]} [opts.audience]
 * @param {Function} [opts.jwks] test override: a jose key-resolver, e.g. from createLocalJWKSet
 * @returns {(token: string) => Promise<object>}
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

        // jose resolves the key by the token's kid and handles multi-key rotation.
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
