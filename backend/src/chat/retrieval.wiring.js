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
const { getChatInference } = require('../providers/llm/inference.provider');
const { promptBudget } = require('../core/provider.limits');
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

// Everything in the prompt that is not retrieved context: system prompt, usage instructions,
// the running summary, recent chat history and the question itself. Retrieval gets what is left.
const NON_CONTEXT_PROMPT_TOKENS = 1600;

/**
 * How many tokens of retrieved context the answering model can actually take.
 *
 * Derived rather than tuned: the ceiling and the answer allowance both come from config and
 * core/provider.limits.json, so changing the model or the answer length moves this by itself.
 * Null when the model has no recorded ceiling, which leaves retrieval on its fixed-count default.
 */
function contextBudget() {
    const { model, taskConfig } = getChatInference();
    return promptBudget(taskConfig.provider, model, {
        completionTokens: taskConfig.maxTokens,
        reserve: NON_CONTEXT_PROMPT_TOKENS,
    });
}

let parts = null;

function get() {
    if (!parts) {
        const index = createChunkSearch({ client: getQdrant(), embed: getEmbeddingWithRetry });
        parts = {
            retrieval: createRetrieval({
                denseSearch: index.denseSearch,
                embedQuery: index.embedQuery,
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
 * @param {number} [opts.maxContextTokens] override the derived budget. Production leaves this
 *   alone; it exists because an evaluation that swaps the answering model would otherwise still
 *   size retrieval against the *configured* model. That mismatch silently handed the
 *   whole-transcript arm 12.8k tokens while retrieval got 4.8k, and the resulting gap looked
 *   like a retrieval failure rather than the budget difference it partly was.
 */
async function buildContext({ query, meetingId, ownerId, nowMs = null, maxContextTokens }) {
    const { retrieval, guard } = get();

    const watermarkMs = await getWatermarkMs(meetingId).catch((err) => {
        logger.warn('Watermark unavailable', { meetingId, error: err.message });
        return null;
    });

    const result = await retrieval.retrieve({
        query, meetingId, ownerId, watermarkMs,
        maxContextTokens: maxContextTokens ?? contextBudget(),
    });

    // Answering from an empty context because the search backends are down produces "the
    // transcript does not mention that", which is indistinguishable from a real answer and is a
    // lie. Fail loudly instead; the caller can tell the user to try again.
    if (result.stats.unavailable) {
        logger.error('Every retrieval lane failed', {
            meetingId, laneFailures: result.stats.laneFailures,
        });
        const err = new Error('retrieval unavailable');
        err.code = 'RETRIEVAL_UNAVAILABLE';
        throw err;
    }

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
