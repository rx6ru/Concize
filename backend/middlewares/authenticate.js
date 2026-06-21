// middlewares/authenticate.js
//
// Dual-mode authentication. Accepts EITHER a valid Supabase JWT (Authorization: Bearer)
// OR a legacy x-auth-code (behind a flag, mapped to one synthetic ownerId) so the current
// extension keeps working until it ships a real login. Sets `req.user = { id, mode, ... }`.
//
// Authorization (does this user own this resource?) is enforced separately by
// requireMeetingAccess — this middleware only answers "who is the caller?".

const crypto = require('crypto');
const { createLogger } = require('../utils/logger');

const logger = createLogger('authenticate');

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
        return false;
    }
}

/**
 * @param {Object} deps
 * @param {(token: string) => Promise<object>} deps.verifyAccessToken Token verifier seam.
 * @param {Object} deps.legacy
 * @param {boolean} deps.legacy.enabled Whether legacy x-auth-code is accepted.
 * @param {string[]} deps.legacy.codes Allowed legacy codes.
 * @param {string} deps.legacy.ownerId Synthetic owner id all legacy traffic maps to.
 * @returns {import('express').RequestHandler}
 */
function createAuthenticate({ verifyAccessToken, legacy }) {
    return async function authenticate(req, res, next) {
        // CORS preflight carries no credentials.
        if (req.method === 'OPTIONS') return next();

        const authHeader = req.headers.authorization || '';
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

        // 1) A Bearer token, if present, is authoritative — never fall back to legacy on failure.
        if (bearer) {
            try {
                const claims = await verifyAccessToken(bearer);
                req.user = {
                    id: claims.sub,
                    email: claims.email,
                    claims,
                    mode: 'jwt',
                };
                return next();
            } catch (err) {
                logger.warn('JWT verification failed', { error: err.message });
                return res.status(401).json({ error: 'Unauthorized: invalid token.' });
            }
        }

        // 2) Legacy fallback (transitional), behind a flag.
        if (legacy && legacy.enabled) {
            const provided = req.headers['x-auth-code'];
            const ok = provided && (legacy.codes || []).some((code) => timingSafeEqual(code, provided));
            if (ok) {
                req.user = { id: legacy.ownerId, mode: 'legacy' };
                return next();
            }
        }

        logger.warn('Authentication failed: no valid credentials');
        return res.status(401).json({ error: 'Unauthorized: authentication required.' });
    };
}

module.exports = { createAuthenticate };
