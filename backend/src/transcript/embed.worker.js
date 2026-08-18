// Embeds stored chunks and pushes them to the vector store. Only records vector_id after the upsert succeeds, otherwise a chunk points at nothing and drops out of search.
// One bad chunk must not stop the rest.

'use strict';

const { createHash } = require('crypto');
const { withContext } = require('./chunk.context');
const { createLogger } = require('../core/logger');

const logger = createLogger('embedWorker');

// Qdrant only takes an unsigned int or a UUID as a point id, so the readable key is hashed into a v5-shaped uuid; same key always gives the same uuid, which makes a re-embed overwrite instead of duplicate.
function uuidFromKey(key) {
    const h = createHash('sha1').update(key).digest('hex');
    const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    return [
        h.slice(0, 8),
        h.slice(8, 12),
        `5${h.slice(13, 16)}`,
        `${variant}${h.slice(17, 20)}`,
        h.slice(20, 32),
    ].join('-');
}

/**
 * @param {object} deps
 * @param {function} deps.getUnembedded   (meetingId, opts) => chunk[]
 * @param {function} deps.getDirtyChunks  (meetingId, opts) => chunk[]
 * @param {function} deps.attachVector    (meetingId, {layer,ordinal,rev}, vectorId) => chunk
 * @param {function} deps.embed           (text) => number[]
 * @param {function} [deps.embedMany]     (texts) => vectors; embeds a whole pass in one call, falling back to one `embed` call per chunk when absent
 * @param {function} deps.upsert          (vectorId, vector, payload) => void
 * @param {number}   [deps.batchSize]
 */
function createEmbedWorker({
    getUnembedded, getDirtyChunks, attachVector, embed, embedMany = null, upsert, batchSize = 32,
}) {

    const chunkKeyFor = (meetingId, c) => `${meetingId}:${c.layer}:${c.ordinal}:${c.rev}`;
    const vectorIdFor = (meetingId, c) => uuidFromKey(chunkKeyFor(meetingId, c));

    async function embedOne(meetingId, chunk, meeting, vector = null) {
        const vectorId = vectorIdFor(meetingId, chunk);
        if (!vector) vector = await embed(withContext(chunk, meeting));

        if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error('embedding returned no vector');
        }

        await upsert(vectorId, vector, {
            meetingId,
            ownerId: meeting.ownerId ?? null,     // tenant isolation at the vector layer too
            chunkKey: chunkKeyFor(meetingId, chunk),   // readable id, the point id is a hash
            layer: chunk.layer,
            ordinal: chunk.ordinal,
            rev: chunk.rev,
            t0Ms: chunk.t0Ms,
            t1Ms: chunk.t1Ms,
            text: chunk.text,
            speakers: chunk.speakers,
            hasOverlap: chunk.hasOverlap,
        });

        // Only now is the chunk considered indexed.
        return attachVector(meetingId, chunk, vectorId);
    }

    return {
        /**
         * Embed everything outstanding for a meeting: never-embedded chunks first, then chunks invalidated by a correction.
         * @returns {{embedded: number, failed: number, failures: object[]}}
         */
        async run(meetingId, meeting = {}) {
            const pending = [
                ...(await getUnembedded(meetingId, { limit: batchSize })),
                ...(await getDirtyChunks(meetingId, { limit: batchSize })),
            ];

            // A dirty chunk that was never embedded appears in both lists.
            const seen = new Set();
            const queue = pending.filter((c) => {
                const key = `${c.layer}:${c.ordinal}:${c.rev}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            let embedded = 0;
            const failures = [];

            // One call for the whole pass: a 116-chunk meeting was 116 requests against a 100-per-minute ceiling, batched it's two. A failure here leaves the whole pass unembedded, picked up next run, same outcome as before but in bulk.
            let vectors = null;
            if (embedMany && queue.length) {
                try {
                    vectors = await embedMany(queue.map((c) => withContext(c, meeting)));
                } catch (err) {
                    logger.error('Batch embed failed, leaving the pass for the next run', {
                        meetingId, chunks: queue.length, error: err.message,
                    });
                    return {
                        embedded: 0,
                        failed: queue.length,
                        failures: queue.map((c) => ({ ordinal: c.ordinal, layer: c.layer, error: err.message })),
                    };
                }
            }

            for (const [i, chunk] of queue.entries()) {
                try {
                    await embedOne(meetingId, chunk, meeting, vectors ? vectors[i] : null);
                    embedded += 1;
                } catch (err) {
                    // Left unembedded so the next run retries it, rather than marked done.
                    failures.push({ ordinal: chunk.ordinal, layer: chunk.layer, error: err.message });
                    logger.error('Chunk embed failed', {
                        meetingId, layer: chunk.layer, ordinal: chunk.ordinal, error: err.message,
                    });
                }
            }

            if (embedded || failures.length) {
                logger.info('Embed pass complete', { meetingId, embedded, failed: failures.length });
            }
            return { embedded, failed: failures.length, failures };
        },

        vectorIdFor,
    };
}

module.exports = { createEmbedWorker };
