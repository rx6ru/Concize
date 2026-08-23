// Minting the access tokens this product's own gateway verifies.
//
// The realtime gateway takes a JWT and nothing else, which until now meant a Supabase project had
// to exist before anyone could record a meeting. Issuing our own removes that dependency: the
// verifier already supports HS256 (token.verifier.js), so a token signed here is accepted with no
// change to the verification path.
//
// Supabase stays supported. Point AUTH_MODE at jwks and its tokens verify exactly as before.

'use strict';

const jose = require('jose');

const ALG = 'HS256';

/**
 * @param {object} deps
 * @param {string} deps.secret    shared with the verifier; both sides read the same env var
 * @param {string} deps.issuer    must match what the verifier expects, when it checks one
 * @param {string} deps.audience  same
 * @param {string} [deps.ttl]     jose duration, e.g. '2h'
 */
function createTokenIssuer({ secret, issuer, audience, ttl = '12h', now = () => new Date() }) {
    if (!secret) throw new Error('tokenIssuer: secret is required');
    const key = new TextEncoder().encode(secret);

    /** @returns {Promise<{token: string, expiresAt: string}>} */
    return async function issueAccessToken(user) {
        if (!user || !user.id) throw new Error('tokenIssuer: user.id is required');

        const issuedAt = now();
        const builder = new jose.SignJWT({ email: user.email })
            .setProtectedHeader({ alg: ALG })
            .setSubject(String(user.id))
            .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
            .setExpirationTime(ttl);

        if (issuer) builder.setIssuer(issuer);
        if (audience) builder.setAudience(audience);

        return { token: await builder.sign(key) };
    };
}

module.exports = { createTokenIssuer, ALG };
