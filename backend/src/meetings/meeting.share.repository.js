// Meeting sharing persistence on Supabase Postgres: who else can read one meeting.

'use strict';

const crypto = require('crypto');
const { query } = require('../infra/postgres');
const { createLogger } = require('../core/logger');

const logger = createLogger('meetingShareRepository');

function toShare(row) {
    return {
        id: row.id,
        meetingId: row.meeting_id,
        sharedWith: row.shared_with,
        grantedBy: row.granted_by,
        createdAt: row.created_at,
    };
}

/**
 * Grants `sharedWith` read access to a meeting. Idempotent: granting an already-shared
 * account again returns the existing row instead of erroring.
 * @returns {Promise<?Object>} the share row, or null on failure.
 */
async function grantShare({ meetingId, sharedWith, grantedBy }) {
    try {
        await query(
            `INSERT INTO meeting_shares (id, meeting_id, shared_with, granted_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (meeting_id, shared_with) DO NOTHING`,
            [crypto.randomUUID(), meetingId, sharedWith, grantedBy]
        );
        const { rows } = await query(
            `SELECT id, meeting_id, shared_with, granted_by, created_at
               FROM meeting_shares WHERE meeting_id = $1 AND shared_with = $2`,
            [meetingId, sharedWith]
        );
        if (!rows.length) return null;
        logger.info('Meeting share granted', { meetingId, sharedWith });
        return toShare(rows[0]);
    } catch (err) {
        logger.error('Error granting meeting share', { meetingId, sharedWith, error: err.message });
        return null;
    }
}

/**
 * Revokes one share by id, scoped to the meeting so a shareId from a different meeting
 * cannot be used to revoke here.
 * @returns {Promise<boolean>} true if a share was removed.
 */
async function revokeShare(meetingId, shareId) {
    try {
        const { rowCount } = await query(
            'DELETE FROM meeting_shares WHERE meeting_id = $1 AND id = $2',
            [meetingId, shareId]
        );
        if (rowCount) logger.info('Meeting share revoked', { meetingId, shareId });
        return rowCount > 0;
    } catch (err) {
        logger.error('Error revoking meeting share', { meetingId, shareId, error: err.message });
        return false;
    }
}

/** Everyone a meeting is currently shared with, oldest grant first. */
async function listShares(meetingId) {
    try {
        const { rows } = await query(
            `SELECT ms.id, ms.shared_with, ms.granted_by, ms.created_at, u.email
               FROM meeting_shares ms
               LEFT JOIN users u ON u.id = ms.shared_with
              WHERE ms.meeting_id = $1
              ORDER BY ms.created_at ASC`,
            [meetingId]
        );
        return rows.map((r) => ({
            id: r.id,
            userId: r.shared_with,
            // Only resolvable for accounts issued locally (see auth/user.repository); a
            // Supabase-authenticated account has no row here to join against.
            email: r.email || null,
            grantedBy: r.granted_by,
            createdAt: r.created_at,
        }));
    } catch (err) {
        logger.error('Error listing meeting shares', { meetingId, error: err.message });
        return [];
    }
}

/**
 * Whether `userId` has been granted read access to `meetingId`.
 * Used by the access gate, so this deliberately does not swallow errors: the gate must be
 * able to tell "not shared" apart from "lookup failed", the same way it does for getMeetingOwner.
 */
async function isSharedWith(meetingId, userId) {
    const { rows } = await query(
        'SELECT 1 FROM meeting_shares WHERE meeting_id = $1 AND shared_with = $2 LIMIT 1',
        [meetingId, userId]
    );
    return rows.length > 0;
}

/**
 * Meetings shared with `userId`, newest grant first. Shaped like
 * meeting.repository.listMeetings' result so a caller can merge the two lists.
 */
async function listSharedMeetings(userId, { limit = 50 } = {}) {
    try {
        const { rows } = await query(
            `SELECT m.job_id, m.status, m.created_at, s.title
               FROM meeting_shares ms
               JOIN meetings m ON m.job_id = ms.meeting_id
               LEFT JOIN meeting_summaries s ON s.job_id = m.job_id
              WHERE ms.shared_with = $1
              ORDER BY ms.created_at DESC
              LIMIT ${Number(limit)}`,
            [userId]
        );
        return rows.map((r) => ({
            meetingId: r.job_id,
            status: r.status,
            createdAt: r.created_at,
            title: r.title || null,
        }));
    } catch (err) {
        logger.error('Error listing shared meetings', { userId, error: err.message });
        return [];
    }
}

module.exports = { grantShare, revokeShare, listShares, isSharedWith, listSharedMeetings };
