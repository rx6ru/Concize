// Qdrant adapter for the chunk collection. Fusion happens in retrieval.pipeline, not here, since that pipeline fuses across layers as well as engines.
// Every query filters on both meetingId and ownerId; the ownerId filter duplicates the API's auth gate on purpose, so tenant isolation doesn't rest on one layer.

'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('chunkSearch');

const VECTOR_SIZE = 768;   // gemini-embedding-001 @768; changing this means a new collection

/**
 * @param {object} deps
 * @param {object} deps.client        Qdrant client
 * @param {function} deps.embed       (text) => number[]
 * @param {string} [deps.collection]
 */
function createChunkSearch({ client, embed, collection = 'concize_chunks' }) {

    async function ensureCollection() {
        const { collections } = await client.getCollections();
        if (collections.some((c) => c.name === collection)) return false;

        await client.createCollection(collection, {
            vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
        });

        // unindexed payload filters are a classic vector-search performance cliff, and every query filters on both of these fields.
        for (const field of ['meetingId', 'ownerId']) {
            await client.createPayloadIndex(collection, { field_name: field, field_schema: 'keyword' })
                .catch((err) => logger.warn('Payload index failed', { field, error: err.message }));
        }
        logger.info('Chunk collection created', { collection });
        return true;
    }

    // Fail closed on the owner: dropping the filter would leave the search scoped by meetingId alone, the bearer-capability model ADR-001 replaced.
    function filterFor(meetingId, ownerId, layer) {
        if (!ownerId) throw new Error('chunk search: ownerId is required; refusing to search unscoped');
        const must = [
            { key: 'meetingId', match: { value: meetingId } },
            { key: 'ownerId', match: { value: ownerId } },
        ];
        if (layer != null) must.push({ key: 'layer', match: { value: layer } });
        return { must };
    }

    /** Embeds a question once so every layer's search can share the vector. */
    async function embedQuery(text) {
        const vector = await embed(text);
        if (!Array.isArray(vector) || !vector.length) {
            throw new Error('query embedding returned no vector');
        }
        return vector;
    }

    return {
        ensureCollection,
        embedQuery,

        async upsert(id, vector, payload) {
            await client.upsert(collection, {
                wait: true,
                points: [{ id, vector, payload }],
            });
        },

        /**
         * Matches the denseSearch contract expected by retrieval.pipeline.
         * `vector` is optional, letting the caller embed the question once for all layers instead of once per layer: previously three requests against a 1000/day quota per question.
         */
        async denseSearch({ query, meetingId, ownerId, layer, limit = 20, vector = null }) {
            const queryVector = vector || await embedQuery(query);

            const hits = await client.search(collection, {
                vector: queryVector,
                filter: filterFor(meetingId, ownerId, layer),
                limit,
                with_payload: true,
            });

            return hits.map((h) => ({
                vectorId: h.id,
                score: h.score,
                layer: h.payload.layer,
                ordinal: h.payload.ordinal,
                rev: h.payload.rev,
                t0Ms: h.payload.t0Ms,
                t1Ms: h.payload.t1Ms,
                text: h.payload.text,
                speakers: h.payload.speakers || [],
                hasOverlap: !!h.payload.hasOverlap,
            }));
        },

        /** Drops every vector for a meeting, e.g. on delete or full re-index. */
        async purgeMeeting(meetingId) {
            await client.delete(collection, {
                wait: true,
                filter: { must: [{ key: 'meetingId', match: { value: meetingId } }] },
            });
            logger.info('Meeting vectors purged', { meetingId });
        },
    };
}

module.exports = { createChunkSearch, VECTOR_SIZE };
