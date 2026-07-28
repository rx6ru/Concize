// Composition root for the chat read path: retrieve, screen, render.
//
// Wires together the vector index, the injection screen, and context assembly so the
// controller doesn't have to know about any of them. Dense and sparse both run; reranking is
// the one slot still empty, so the pipeline falls back to fusion order.

'use strict';

const { getQdrant } = require('../infra/qdrant');
// Retrying, like the write path: the question has to be embedded before anything can be
// retrieved, so a bare 429 here costs the whole answer rather than one chunk's freshness.
const { getEmbeddingWithRetry } = require('../providers/embedding/embedding.service');
const { createChunkSearch } = require('./chunk.search');
const { createRetrieval } = require('./retrieval.pipeline');
const { assemble } = require('./context.assembly');
const { createInjectionGuard } = require('../safety/injection.guard');
const { runResilient } = require('../providers/llm/resilient.inference');
const groqService = require('../providers/llm/groq');
const { getRecentTurns, getWatermarkMs } = require('../transcript/utterance.repository');
const { searchChunkText } = require('../transcript/chunk.repository');
const { createLogger } = require('../core/logger');

const logger = createLogger('retrievalWiring');

// The guard is a classifier, not a chat model, so no sampling params and no retry. It has its
// own timeout and fails open; retrying would just eat into the time budget it's meant to bound.
const complete = ({ model, messages }) =>
    runResilient(
        'groq',
        () => groqService.getClient().chat.completions.create({ model, messages }),
        { maxRetries: 0 }
    );

let parts = null;

function get() {
    if (!parts) {
        const index = createChunkSearch({ client: getQdrant(), embed: getEmbeddingWithRetry });
        parts = {
            retrieval: createRetrieval({
                denseSearch: index.denseSearch,
                sparseSearch: ({ query: text, meetingId, ownerId, layer, limit }) =>
                    searchChunkText(meetingId, { text, ownerId, layer, limit }),
                recentTurns: ({ meetingId, sinceMs }) =>
                    getRecentTurns(meetingId, { windowMs: sinceMs }),
            }),
            guard: createInjectionGuard({ complete }),
        };
    }
    return parts;
}

/** Screens a user question. Fails open, see injection.guard. */
async function checkQuery(text) {
    return get().guard.checkQuery(text);
}

/**
 * Builds the context block for one question.
 *
 * Returns null when the meeting has nothing indexed, so the caller can fall back rather than
 * ask the model to answer from an empty block.
 *
 * @param {object} opts
 * @param {number} [opts.nowMs] current session time, for the staleness line. The chat request
 *   does not carry a session clock yet, so staleness is normally omitted rather than faked.
 */
async function buildContext({ query, meetingId, ownerId, nowMs = null }) {
    const { retrieval, guard } = get();

    const watermarkMs = await getWatermarkMs(meetingId).catch((err) => {
        logger.warn('Watermark unavailable', { meetingId, error: err.message });
        return null;
    });

    const result = await retrieval.retrieve({ query, meetingId, ownerId, watermarkMs });
    if (!result.context.length) return null;

    // Screening marks lines, it does not remove them (see injection.guard).
    const screened = await guard.filterContext(result.context);
    const stats = { ...result.stats, injectionFlagged: screened.flagged };

    return {
        ...assemble({ ...result, context: screened.items, stats }, { nowMs }),
        stats,
    };
}

/** Test seam. */
function _resetForTests() {
    parts = null;
}

module.exports = { buildContext, checkQuery, _resetForTests };
