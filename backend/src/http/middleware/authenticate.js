// Authentication: a valid Supabase JWT in `Authorization: Bearer`, and nothing else.
// Sets `req.user = { id, email, claims }`.
//
// Authorization (does this user own this resource?) is enforced separately by
// requireMeetingAccess; this middleware only answers "who is the caller?".

const { createLogger } = require('../../core/logger');
const { getContext } = require('../../core/request.context');

const logger = createLogger('authenticate');

/**
 * @param {Object} deps
 * @param {(token: string) => Promise<object>} deps.verifyAccessToken Token verifier seam.
 * @returns {import('express').RequestHandler}
 */
function createAuthenticate({ verifyAccessToken }) {
    return async function authenticate(req, res, next) {
        // CORS preflight carries no credentials.
        if (req.method === 'OPTIONS') return next();

        const authHeader = req.headers.authorization || '';
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

        if (!bearer) {
            logger.warn('Authentication failed: no bearer token');
            return res.status(401).json({ error: 'Unauthorized: authentication required.' });
        }

        try {
            const claims = await verifyAccessToken(bearer);
            req.user = { id: claims.sub, email: claims.email, claims };
            // Stamps the caller onto the per-request context too, so downstream modules (e.g.
            // safety/security.monitor.js) can key per-user state without req threaded through them.
            const ctx = getContext();
            if (ctx) ctx.userId = claims.sub;
            return next();
        } catch (err) {
            logger.warn('JWT verification failed', { error: err.message });
            return res.status(401).json({ error: 'Unauthorized: invalid token.' });
        }
    };
}

module.exports = { createAuthenticate };
