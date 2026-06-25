//
// Meeting + transcript persistence on Supabase Postgres.

const { query } = require('../infra/postgres');
const { createLogger } = require('../core/logger');

const logger = createLogger('meetingRepository');

/**
 * Creates a new meeting owned by `ownerId`.
 * @param {string} jobId Unique meeting id.
 * @param {string} ownerId Owning user id.
 * @returns {Promise<boolean>} True on success.
 */
async function createTranscription(jobId, ownerId) {
    try {
        await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', [jobId, ownerId]);
        logger.info('New meeting created', { jobId, ownerId });
        return true;
    } catch (err) {
        logger.error('Error creating meeting', { jobId, error: err.message });
        return false;
    }
}

/**
 * Resolves a meeting's owner (used by the authorization gate).
 * @param {string} jobId
 * @returns {Promise<string|null>} ownerId, or null if the meeting does not exist.
 */
async function getMeetingOwner(jobId) {
    const { rows } = await query('SELECT owner_id FROM meetings WHERE job_id = $1', [jobId]);
    return rows.length ? rows[0].owner_id : null;
}

/**
 * Appends a transcript chunk, assigning the next sequential index atomically.
 * @param {string} jobId
 * @param {string} newText
 * @returns {Promise<{success: boolean, chunkIndex: number, error?: Error}>}
 */
async function appendTranscription(jobId, newText) {
    try {
        const { rows } = await query(
            `INSERT INTO transcription_chunks (job_id, chunk_index, text)
             SELECT $1, COALESCE(MAX(chunk_index) + 1, 0), $2
               FROM transcription_chunks WHERE job_id = $1
             RETURNING chunk_index`,
            [jobId, newText]
        );
        if (rows.length) {
            const chunkIndex = rows[0].chunk_index;
            logger.info('Appended transcript chunk', { jobId, chunkIndex });
            return { success: true, chunkIndex };
        }
        logger.warn('Failed to append chunk - no row returned', { jobId });
        return { success: false, chunkIndex: -1 };
    } catch (err) {
        // e.g. FK violation when the meeting does not exist.
        logger.error('Error appending transcript chunk', { jobId, error: err.message });
        return { success: false, chunkIndex: -1, error: err };
    }
}

/**
 * @param {string} jobId
 * @param {string} newStatus
 * @returns {Promise<boolean>} True if a meeting row was updated.
 */
async function updateMeetingStatus(jobId, newStatus) {
    try {
        const { rowCount } = await query('UPDATE meetings SET status = $2 WHERE job_id = $1', [jobId, newStatus]);
        return rowCount > 0;
    } catch (err) {
        logger.error('Error updating meeting status', { jobId, newStatus, error: err.message });
        return false;
    }
}

/**
 * @param {string} jobId
 * @returns {Promise<string|null>} The status, or null if not found.
 */
async function getMeetingStatus(jobId) {
    try {
        const { rows } = await query('SELECT status FROM meetings WHERE job_id = $1', [jobId]);
        return rows.length ? rows[0].status : null;
    } catch (err) {
        logger.error('Error fetching meeting status', { jobId, error: err.message });
        return null;
    }
}

/**
 * Returns the full transcript document for a meeting (shape mirrors the previous API:
 * `{ status, transcriptionChunks, createdAt }`), or null if the meeting does not exist.
 * @param {string} jobId
 */
async function getTranscription(jobId) {
    try {
        const meetingRes = await query('SELECT status, created_at FROM meetings WHERE job_id = $1', [jobId]);
        if (!meetingRes.rows.length) {
            logger.warn('No meeting found', { jobId });
            return null;
        }
        const chunkRes = await query(
            'SELECT text FROM transcription_chunks WHERE job_id = $1 ORDER BY chunk_index ASC',
            [jobId]
        );
        return {
            status: meetingRes.rows[0].status,
            createdAt: meetingRes.rows[0].created_at,
            transcriptionChunks: chunkRes.rows.map((r) => r.text),
        };
    } catch (err) {
        logger.error('Error fetching transcript', { jobId, error: err.message });
        return null;
    }
}

module.exports = {
    createTranscription,
    getMeetingOwner,
    appendTranscription,
    getTranscription,
    updateMeetingStatus,
    getMeetingStatus,
};
