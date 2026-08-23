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
 * @param {(meetingId: string, callerId: string) => Promise<boolean>} [deps.hasSharedAccess]
 *        Whether the meeting has been shared with callerId. Only consulted when callerId is
 *        not the owner. Defaults to "never shared", so callers that don't pass it (existing
 *        tests, other wirings) keep the pre-sharing owner-only behavior unchanged.
 * @param {(req: import('express').Request) => string|undefined} [deps.getMeetingId]
 *        Extracts the meeting id from the request. Defaults to `req.params.meetingId`
 *        (RESTful routes); legacy routes pass a resolver reading the cookie/body jobId.
 * @returns {import('express').RequestHandler}
 */
function createRequireMeetingAccess({ getMeetingOwner, hasSharedAccess = async () => false, getMeetingId }) {
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

        // Unknown meeting → 404 (no existence leak), and nothing to share-check against.
        if (!ownerId) {
            logger.warn('Meeting access denied', { meetingId, callerId: req.user.id });
            return res.status(404).json({ error: 'Meeting not found.' });
        }

        if (ownerId === req.user.id) {
            req.meeting = { meetingId, ownerId };
            return next();
        }

        let shared;
        try {
            shared = await hasSharedAccess(meetingId, req.user.id);
        } catch (err) {
            logger.error('Shared-access lookup failed', { meetingId, error: err.message });
            return res.status(500).json({ error: 'Failed to verify meeting access.' });
        }

        // Not owned AND not shared with the caller → identical 404 (no existence leak).
        if (!shared) {
            logger.warn('Meeting access denied', { meetingId, callerId: req.user.id });
            return res.status(404).json({ error: 'Meeting not found.' });
        }

        // ownerId stays the true owner here, never the caller: every retrieval lane scopes
        // by req.meeting.ownerId, and a shared reader's chunks live under the owner's id.
        req.meeting = { meetingId, ownerId };
        return next();
    };
}

/**
 * Extra gate for owner-only actions (delete, sharing management) on a meeting requireMeetingAccess
 * has already let through. A shared reader has already been proven to have access, so denying
 * here is 403, not 404: they already know the meeting exists.
 */
function requireMeetingOwner(req, res, next) {
    if (!req.meeting || !req.user || req.meeting.ownerId !== req.user.id) {
        logger.warn('Owner-only action denied', { meetingId: req.meeting?.meetingId, callerId: req.user?.id });
        return res.status(403).json({ error: 'Only the meeting owner can do this.' });
    }
    return next();
}

module.exports = { createRequireMeetingAccess, requireMeetingOwner };
