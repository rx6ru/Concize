//
// Meeting-summary persistence on Supabase Postgres.
// The incremental update uses a real transaction with row locking (SELECT ... FOR UPDATE),
// replacing the previous Mongo "atomic findOneAndUpdate + 2s delay" race workaround.

const { query, withTransaction } = require('../infra/postgres');
const { createLogger } = require('../core/logger');

const logger = createLogger('summaryRepository');

/** Maps a snake_case row to the camelCase shape callers expect. */
function mapSummary(row) {
    if (!row) return null;
    return {
        jobId: row.job_id,
        title: row.title,
        content: row.content,
        wordLimit: row.word_limit,
        lastProcessedChunkIndex: row.last_processed_chunk_index,
        version: row.version,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * @param {string} jobId
 * @returns {Promise<Object|null>} The summary (camelCase), or null if not found.
 */
const getMeetingSummary = async (jobId) => {
    try {
        const { rows } = await query('SELECT * FROM meeting_summaries WHERE job_id = $1', [jobId]);
        return rows.length ? mapSummary(rows[0]) : null;
    } catch (error) {
        logger.error('Failed to fetch summary', { jobId, error: error.message });
        throw error;
    }
};

/**
 * Reserves processing of `chunkIndex`, enforcing strict in-order processing.
 * Only proceeds if last_processed_chunk_index === chunkIndex - 1; chunk 0 creates the row.
 * Runs in a transaction with FOR UPDATE so concurrent workers can't double-process.
 *
 * @param {string} jobId
 * @param {number} chunkIndex
 * @returns {Promise<Object>} The reserved summary (status='updating', version bumped).
 * @throws {Error} On out-of-order or missing-start.
 */
const startSummaryUpdate = async (jobId, chunkIndex) => {
    try {
        return await withTransaction(async (client) => {
            const cur = await client.query(
                'SELECT * FROM meeting_summaries WHERE job_id = $1 FOR UPDATE',
                [jobId]
            );
            const row = cur.rows[0];

            if (!row) {
                if (chunkIndex !== 0) {
                    throw new Error(`Summary document indicates missing start for chunk ${chunkIndex}`);
                }
                const ins = await client.query(
                    `INSERT INTO meeting_summaries (job_id, title, status, version, last_processed_chunk_index)
                     VALUES ($1, 'New Meeting', 'updating', 1, -1)
                     RETURNING *`,
                    [jobId]
                );
                return mapSummary(ins.rows[0]);
            }

            if (row.last_processed_chunk_index !== chunkIndex - 1) {
                logger.warn('Skipped chunk: out of order', {
                    jobId, chunkIndex, expected: row.last_processed_chunk_index + 1,
                });
                throw new Error(`Out of order: chunk ${chunkIndex}, expected ${row.last_processed_chunk_index + 1}`);
            }

            const upd = await client.query(
                `UPDATE meeting_summaries
                    SET status = 'updating', version = version + 1, updated_at = now()
                  WHERE job_id = $1
                  RETURNING *`,
                [jobId]
            );
            return mapSummary(upd.rows[0]);
        });
    } catch (error) {
        logger.error('Failed to start summary update', { jobId, chunkIndex, error: error.message });
        throw error;
    }
};

/**
 * Persists generated content for a processed chunk.
 * @param {string} jobId
 * @param {{title: string, summary: string}} updatedData
 * @param {number} chunkIndex
 */
const saveSummaryContent = async (jobId, updatedData, chunkIndex) => {
    try {
        await query(
            `UPDATE meeting_summaries
                SET title = $2, content = $3, last_processed_chunk_index = $4,
                    status = 'updating', updated_at = now()
              WHERE job_id = $1`,
            [jobId, updatedData.title, updatedData.summary, chunkIndex]
        );
        logger.info('Summary chunk saved', { jobId, chunkIndex });
    } catch (error) {
        logger.error('Failed to save summary content', { jobId, error: error.message });
        throw error;
    }
};

/** Marks the summary fully complete (end of meeting). */
const completeSummary = async (jobId) => {
    try {
        await query(
            "UPDATE meeting_summaries SET status = 'complete', updated_at = now() WHERE job_id = $1",
            [jobId]
        );
        logger.info('Summary finalized', { jobId });
    } catch (error) {
        logger.error('Failed to complete summary', { jobId, error: error.message });
        throw error;
    }
};

module.exports = {
    getMeetingSummary,
    startSummaryUpdate,
    saveSummaryContent,
    completeSummary,
};
