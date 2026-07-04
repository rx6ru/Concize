// Storage for derived retrievable chunks.
// Everything here can be rebuilt from `utterances` by replay. A correction writes a new
// `rev` instead of mutating in place, so a reader mid-query never sees a chunk change under it.

'use strict';

const { query } = require('../infra/postgres');
const { createLogger } = require('../core/logger');

const logger = createLogger('chunkRepository');

const COLUMNS = `meeting_id, layer, ordinal, rev, t0_ms, t1_ms, text, context_prefix,
                 turn_ids, speakers, has_overlap, tokens, vector_id, dirty, created_at`;

function toChunk(row) {
    return {
        meetingId: row.meeting_id,
        layer: row.layer,
        ordinal: row.ordinal,
        rev: row.rev,
        t0Ms: row.t0_ms,
        t1Ms: row.t1_ms,
        text: row.text,
        contextPrefix: row.context_prefix,
        turnIds: row.turn_ids || [],
        speakers: row.speakers || [],
        hasOverlap: row.has_overlap,
        tokens: row.tokens,
        vectorId: row.vector_id,
        dirty: row.dirty,
        createdAt: row.created_at,
    };
}

async function insertChunk(meetingId, chunk) {
    const {
        layer = 1, ordinal, rev = 0, t0Ms, t1Ms, text,
        contextPrefix = '', turnIds = [], speakers = [],
        hasOverlap = false, tokens = 0,
    } = chunk;

    const { rows } = await query(
        `INSERT INTO chunks
           (meeting_id, layer, ordinal, rev, t0_ms, t1_ms, text, context_prefix,
            turn_ids, speakers, has_overlap, tokens)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${COLUMNS}`,
        [meetingId, layer, ordinal, rev, t0Ms, t1Ms, text, contextPrefix,
         turnIds, speakers, hasOverlap, tokens]
    );
    return toChunk(rows[0]);
}

/**
 * Latest revision of each chunk in a layer, in spoken order.
 *
 * Deduped in JS rather than by a correlated subquery: the SQL form is not portable across
 * our test engine, and a meeting holds hundreds of chunks, not millions.
 */
async function getChunks(meetingId, layer = 1) {
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM chunks
          WHERE meeting_id = $1 AND layer = $2
          ORDER BY ordinal ASC, rev DESC`,
        [meetingId, layer]
    );

    const latest = [];
    let lastOrdinal = null;
    for (const row of rows) {
        if (row.ordinal === lastOrdinal) continue;   // rev DESC, so the first wins
        lastOrdinal = row.ordinal;
        latest.push(toChunk(row));
    }
    return latest;
}

/**
 * Flags every chunk whose time range intersects a corrected utterance.
 *
 * Intersection on time rather than turn-id membership: it is portable SQL, and a revision
 * that shifts an utterance's boundaries should dirty the chunks it moved *into* as well as
 * the ones it left.
 */
async function markDirtyForRange(meetingId, t0Ms, t1Ms) {
    const { rows } = await query(
        `UPDATE chunks SET dirty = true
          WHERE meeting_id = $1 AND t0_ms < $3 AND t1_ms > $2
          RETURNING ${COLUMNS}`,
        [meetingId, t0Ms, t1Ms]
    );
    if (rows.length) {
        logger.info('Chunks marked dirty', { meetingId, count: rows.length, t0Ms, t1Ms });
    }
    return rows.map(toChunk);
}

async function getDirtyChunks(meetingId, { limit = 100 } = {}) {
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM chunks
          WHERE meeting_id = $1 AND dirty = true
          ORDER BY layer ASC, ordinal ASC
          LIMIT ${Number(limit)}`,
        [meetingId]
    );
    return rows.map(toChunk);
}

/** Records the vector this chunk now lives at, and clears the dirty flag. */
async function attachVector(meetingId, { layer, ordinal, rev }, vectorId) {
    const { rows } = await query(
        `UPDATE chunks SET vector_id = $5, dirty = false
          WHERE meeting_id = $1 AND layer = $2 AND ordinal = $3 AND rev = $4
          RETURNING ${COLUMNS}`,
        [meetingId, layer, ordinal, rev, vectorId]
    );
    return rows.length ? toChunk(rows[0]) : null;
}

/** Chunks with no vector yet, the embedding worker's queue. */
async function getUnembedded(meetingId, { limit = 100 } = {}) {
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM chunks
          WHERE meeting_id = $1 AND vector_id IS NULL
          ORDER BY layer ASC, ordinal ASC
          LIMIT ${Number(limit)}`,
        [meetingId]
    );
    return rows.map(toChunk);
}

module.exports = {
    insertChunk,
    getChunks,
    markDirtyForRange,
    getDirtyChunks,
    attachVector,
    getUnembedded,
};
