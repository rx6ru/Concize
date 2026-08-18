// Authorization gate for meeting-scoped resources: loads the meeting's owner and confirms the authenticated caller owns it.
// Cross-tenant and non-existent meetings both return 404, never 403, so the API never reveals that someone else's meeting exists.
//
// Must run AFTER `authenticate` (which sets req.user). Attaches req.meeting on success.

const { createLogger } = require('../../core/logger');

const logger = createLogger('requireMeetingAccess');

/**
 * @param {Object} deps
 * @param {(meetingId: string) => Promise<string|null>} deps.getMeetingOwner
 *        Resolves a meetingId to its ownerId, or null if the meeting does not exist.
 * @param {(req: import('express').Request) => string|undefined} [deps.getMeetingId]
 *        Extracts the meeting id from the request. Defaults to `req.params.meetingId`
 *        (RESTful routes); legacy routes pass a resolver reading the cookie/body jobId.
 * @returns {import('express').RequestHandler}
 */
function createRequireMeetingAccess({ getMeetingOwner, getMeetingId }) {
    const resolveId = getMeetingId || ((req) => req.params.meetingId);
    return async function requireMeetingAccess(req, res, next) {
        const meetingId = resolveId(req);

        if (!req.user || !req.user.id) {
            // Defense in depth: this should already be guaranteed by `authenticate`.
            return res.status(401).json({ error: 'Unauthorized: authentication required.' });
        }
        if (!meetingId) {
            return res.status(400).json({ error: 'meetingId is required.' });
        }

        let ownerId;
        try {
            ownerId = await getMeetingOwner(meetingId);
        } catch (err) {
            logger.error('Ownership lookup failed', { meetingId, error: err.message });
            return res.status(500).json({ error: 'Failed to verify meeting access.' });
        }

        // Unknown meeting OR not owned by caller → identical 404 (no existence leak).
        if (!ownerId || ownerId !== req.user.id) {
            logger.warn('Meeting access denied', { meetingId, callerId: req.user.id });
            return res.status(404).json({ error: 'Meeting not found.' });
        }

        req.meeting = { meetingId, ownerId };
        return next();
    };
}

module.exports = { createRequireMeetingAccess };
