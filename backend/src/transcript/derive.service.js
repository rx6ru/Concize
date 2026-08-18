// Turns finalised utterances into stored, retrievable chunks. The gateway persists an utterance and returns; deriving chunks, embedding them, and maintaining higher layers happens after that.
// A failure here costs freshness, not transcription.

'use strict';

const { createChunker } = require('./chunk.boundary');
const { createLogger } = require('../core/logger');

const logger = createLogger('deriveService');

/**
 * @param {object} deps
 * @param {function} deps.insertChunk
 * @param {function} [deps.markDirtyForRange]
 * @param {object}   [deps.chunkerOptions]
 * @param {function} [deps.onChunk]   called after a chunk is stored, e.g. to enqueue embedding
 */
function createDeriveService({ insertChunk, markDirtyForRange = null, nextOrdinal = null, chunkerOptions = {}, onChunk = () => {} }) {
    // One chunker per live meeting: boundaries depend on the running buffer, so state can't be shared or rebuilt per-utterance without losing the buffer.
    const chunkers = new Map();

    async function chunkerFor(meetingId) {
        if (!chunkers.has(meetingId)) {
            const startOrdinal = nextOrdinal ? await nextOrdinal(meetingId, 1) : 0;
            chunkers.set(meetingId, createChunker({ ...chunkerOptions, startOrdinal }));
        }
        return chunkers.get(meetingId);
    }

    async function store(meetingId, chunk) {
        const stored = await insertChunk(meetingId, { ...chunk, layer: 1 });
        logger.info('Chunk stored', {
            meetingId, ordinal: stored.ordinal, reason: chunk.reason, tokens: chunk.tokens,
        });
        await onChunk(meetingId, stored);
        return stored;
    }

    return {
        /**
         * Feed one finalised utterance. Returns the chunk it closed, or null.
         * Errors are swallowed and logged: derivation must not break ingestion.
         */
        async ingest(meetingId, utterance, embedding = null) {
            try {
                const chunker = await chunkerFor(meetingId);
                const closed = chunker.add(utterance, embedding);
                return closed ? await store(meetingId, closed) : null;
            } catch (err) {
                logger.error('Derive failed', { meetingId, error: err.message });
                return null;
            }
        },

        /**
         * A corrected utterance invalidates any chunk overlapping its span, and the open buffer may already contain the stale text, so the buffer is dropped too.
         */
        async onUtteranceRevised(meetingId, utterance) {
            try {
                if (markDirtyForRange) {
                    await markDirtyForRange(meetingId, utterance.t0Ms, utterance.t1Ms);
                }
                // If the corrected turn is still in the open buffer, patch it there; flushing instead would throw the buffer away, and every speaker revision would take the pending transcript with it.
                const chunker = chunkers.get(meetingId);
                if (chunker) {
                    const { turnId, ...changes } = utterance;
                    chunker.revise(String(turnId), changes);
                }
            } catch (err) {
                logger.error('Dirty marking failed', { meetingId, error: err.message });
            }
        },

        /** Close the open chunk at end of meeting and release the chunker. */
        async finish(meetingId) {
            const chunker = chunkers.get(meetingId);
            if (!chunker) return null;
            chunkers.delete(meetingId);

            const closed = chunker.flush();
            if (!closed) return null;
            try {
                return await store(meetingId, closed);
            } catch (err) {
                logger.error('Final chunk store failed', { meetingId, error: err.message });
                return null;
            }
        },

        active() {
            return chunkers.size;
        },
    };
}

module.exports = { createDeriveService };
