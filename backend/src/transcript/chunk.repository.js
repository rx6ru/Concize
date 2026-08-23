// Storage for derived retrievable chunks. Everything here can be rebuilt from `utterances` by replay.
// A correction writes a new `rev` instead of mutating in place, so a reader mid-query never sees a chunk change under it.

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
 * Turns a question into an OR query over its terms.
 * plainto_tsquery ANDs everything, so "what's the budget?" would only match a chunk containing all those words, almost never; any-term matching with ranking deciding is what lexical retrieval (BM25-style) wants.
 * Punctuation is stripped rather than escaped, so user input can't be read as tsquery syntax; single characters are dropped too since they match everything and rank nothing.
 */
function toOrQuery(text) {
    const terms = String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2);
    return terms.join(' | ');
}

/**
 * Lexical search over stored chunks, the sparse half of retrieval.
 * Matches the shape denseSearch returns so retrieval can fuse the two without caring which engine produced what; ranking only needs to order sensibly, since fusion works on rank.
 * Needs real Postgres: pg-mem has no full text search, so this is covered by tests/chunk.text.search.test.js instead of the pg-mem suites.
 */
async function searchChunkText(meetingId, { text, ownerId = null, layer = null, limit = 20 } = {}) {
    // Fail closed, like the dense lane: without an owner this used to match on meeting alone.
    if (!ownerId) throw new Error('searchChunkText: ownerId is required; refusing to search unscoped');

    const tsquery = toOrQuery(text || '');
    if (!tsquery) return [];

    const { rows } = await query(
        `SELECT * FROM (
             SELECT DISTINCT ON (c.layer, c.ordinal)
                    c.layer, c.ordinal, c.rev, c.t0_ms, c.t1_ms, c.text,
                    c.speakers, c.has_overlap, c.vector_id,
                    ts_rank_cd(to_tsvector('simple', c.context_prefix || ' ' || c.text), q.tsq) AS rank
               FROM chunks c
               JOIN meetings m ON m.job_id = c.meeting_id
               CROSS JOIN to_tsquery('simple', $2) AS q(tsq)
              WHERE c.meeting_id = $1
                AND m.owner_id = $3
                AND ($4::int IS NULL OR c.layer = $4)
                AND to_tsvector('simple', c.context_prefix || ' ' || c.text) @@ q.tsq
              ORDER BY c.layer, c.ordinal, c.rev DESC
         ) hit
         ORDER BY hit.rank DESC
         LIMIT $5`,
        [meetingId, tsquery, ownerId, layer, limit]
    );

    return rows.map((row) => ({
        vectorId: row.vector_id,
        score: Number(row.rank),
        layer: row.layer,
        ordinal: row.ordinal,
        rev: row.rev,
        t0Ms: row.t0_ms,
        t1Ms: row.t1_ms,
        text: row.text,
        speakers: row.speakers || [],
        hasOverlap: row.has_overlap,
    }));
}

/**
 * Lexical search across every meeting the caller owns, not just one, the "what did we decide
 * about pricing" query a single-meeting search can't answer.
 * Same fail-closed shape as searchChunkText, except the scope IS the owner: there is no
 * meetingId to also check, so getting ownerId right here is the entire security boundary.
 */
async function searchChunkTextForOwner(ownerId, { text, limit = 20, offset = 0 } = {}) {
    if (!ownerId) throw new Error('searchChunkTextForOwner: ownerId is required; refusing to search unscoped');

    const tsquery = toOrQuery(text || '');
    if (!tsquery) return [];

    const { rows } = await query(
        `SELECT * FROM (
             SELECT DISTINCT ON (c.meeting_id, c.layer, c.ordinal)
                    c.meeting_id, c.t0_ms, c.t1_ms, c.text, s.title,
                    ts_rank_cd(to_tsvector('simple', c.context_prefix || ' ' || c.text), q.tsq) AS rank
               FROM chunks c
               JOIN meetings m ON m.job_id = c.meeting_id
               LEFT JOIN meeting_summaries s ON s.job_id = m.job_id
               CROSS JOIN to_tsquery('simple', $2) AS q(tsq)
              WHERE m.owner_id = $1
                AND to_tsvector('simple', c.context_prefix || ' ' || c.text) @@ q.tsq
              ORDER BY c.meeting_id, c.layer, c.ordinal, c.rev DESC
         ) hit
         ORDER BY hit.rank DESC, hit.meeting_id, hit.t0_ms
         LIMIT $3 OFFSET $4`,
        [ownerId, tsquery, limit, offset]
    );

    return rows.map((row) => ({
        meetingId: row.meeting_id,
        title: row.title || null,
        text: row.text,
        t0Ms: row.t0_ms,
        t1Ms: row.t1_ms,
        score: Number(row.rank),
    }));
}

/**
 * Next free ordinal for a layer; a meeting resumed after a restart keeps numbering from here, or the insert collides with a pre-restart chunk on the primary key.
 */
async function nextOrdinal(meetingId, layer = 1) {
    const { rows } = await query(
        'SELECT COALESCE(MAX(ordinal), -1) AS highest FROM chunks WHERE meeting_id = $1 AND layer = $2',
        [meetingId, layer]
    );
    return Number(rows[0].highest) + 1;
}

/**
 * Latest revision of each chunk in a layer, in spoken order.
 * Deduped in JS rather than a correlated subquery: not portable to the test engine, and a meeting holds hundreds of chunks, not millions.
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
 * Intersection on time rather than turn-id membership: portable SQL, and a revision that shifts an utterance's boundaries should dirty the chunks it moved *into* as well as the ones it left.
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
    nextOrdinal,
    searchChunkText,
    searchChunkTextForOwner,
    getChunks,
    markDirtyForRange,
    getDirtyChunks,
    attachVector,
    getUnembedded,
};
