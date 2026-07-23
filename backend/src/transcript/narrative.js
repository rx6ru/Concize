// Rewrites a run of layer-1 chunks into third-person narrative prose for layer 2, so retrieval
// can match abstract questions against prose instead of raw disfluent speech. Buffered per
// meeting, drained once enough chunks accumulate or on flush at meeting end.

'use strict';

const { estimateTokens } = require('./chunk.boundary');
const { createLogger } = require('../core/logger');

const logger = createLogger('narrative');

const NARRATE_PROMPT = 'Write a third-person, past-tense narrative of what was discussed and '
    + 'decided below. Plain prose, not a bulleted list or notes. Attribute statements only to '
    + 'the speaker labels given, never invent a name.';

const MAX_TOKENS = 700;

function unionSpeakers(chunks) {
    return [...new Set(chunks.flatMap((c) => c.speakers || []))];
}

function buildUserMessage(chunks) {
    const speakers = unionSpeakers(chunks).join(', ');
    const t0 = chunks[0].t0Ms;
    const t1 = chunks[chunks.length - 1].t1Ms;
    const lines = chunks.map((c) => `${(c.speakers || []).join('/') || 'unknown'}: ${c.text}`);
    return `Speakers: ${speakers}\nTime range: ${t0}ms to ${t1}ms\n\n${lines.join('\n')}`;
}

function buildChunk(chunks, ordinal, text) {
    return {
        layer: 2,
        ordinal,
        t0Ms: chunks[0].t0Ms,
        t1Ms: chunks[chunks.length - 1].t1Ms,
        text,
        speakers: unionSpeakers(chunks),
        hasOverlap: chunks.some((c) => c.hasOverlap),
        turnIds: chunks.flatMap((c) => c.turnIds || []),
        tokens: estimateTokens(text),
        sourceOrdinals: chunks.map((c) => c.ordinal),
    };
}

/**
 * @param {object} deps
 * @param {function} deps.complete   ({model, messages, temperature, max_completion_tokens}) => provider response
 * @param {string} deps.model
 * @param {number} [deps.minChunks]
 * @param {number} [deps.maxChunks]
 * @param {number} [deps.timeoutMs]
 */
function createNarrator({ complete, model, nextOrdinal = null, minChunks = 4, maxChunks = 8, timeoutMs = 20000 }) {
    // One buffer per live meeting: { buffer: layer1Chunk[], ordinal: number }.
    const meetings = new Map();

    // Synchronous: an await here lets two concurrent chunks both pass the length check and
    // both start narrating the same span. The ordinal is resolved at emit time instead.
    function stateFor(meetingId) {
        if (!meetings.has(meetingId)) {
            meetings.set(meetingId, { buffer: [], ordinal: null, busy: false });
        }
        return meetings.get(meetingId);
    }

    // Resumed meetings carry on numbering, or the insert collides on the primary key.
    async function ordinalFor(meetingId, state) {
        if (state.ordinal === null) {
            state.ordinal = nextOrdinal ? await nextOrdinal(meetingId, 2) : 0;
        }
        return state.ordinal;
    }

    async function narrate(chunks) {
        // clear the timer even when it loses the race, or it holds the event loop open until it fires
        let timer;
        try {
            const response = await Promise.race([
                complete({
                    model,
                    messages: [
                        { role: 'system', content: NARRATE_PROMPT },
                        { role: 'user', content: buildUserMessage(chunks) },
                    ],
                    temperature: 0.2,
                    max_completion_tokens: MAX_TOKENS,
                }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('narrator timeout')), timeoutMs);
                }),
            ]);

            const text = response?.choices?.[0]?.message?.content;
            if (typeof text !== 'string' || !text.trim()) {
                logger.warn('Empty or non-string narrative, keeping buffer');
                return null;
            }
            return text.trim();
        } catch (err) {
            logger.error('Narration failed, keeping buffer', { error: err.message });
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        /** Buffer one layer-1 chunk. Returns a layer-2 chunk once enough accumulate, else null. */
        async add(meetingId, layer1Chunk) {
            const state = stateFor(meetingId);
            state.buffer.push(layer1Chunk);

            // one narration per meeting at a time. without this a burst of chunks starts a call
            // per chunk, they all narrate overlapping spans and the provider times them out.
            if (state.busy) return null;
            if (state.buffer.length < minChunks && state.buffer.length < maxChunks) return null;

            const span = state.buffer.slice(0, maxChunks);
            state.busy = true;
            try {
                const text = await narrate(span);
                if (!text) {
                    // a provider outage must not keep growing the buffer for the rest of the meeting
                    if (state.buffer.length >= maxChunks) {
                        logger.warn('Dropping narrative span after repeated failures',
                            { meetingId, chunks: state.buffer.length });
                        state.buffer = state.buffer.slice(span.length);
                    }
                    return null;
                }

                const ordinal = await ordinalFor(meetingId, state);
                const chunk = buildChunk(span, ordinal, text);
                state.ordinal = ordinal + 1;
                // only drop what was narrated; more may have arrived during the call
                state.buffer = state.buffer.slice(span.length);
                return chunk;
            } finally {
                state.busy = false;
            }
        },

        /**
         * Emit everything pending for a meeting, even below minChunks, and forget it.
         *
         * Chunks that queued behind an in-flight narration are still here, so the backlog can be
         * far wider than maxChunks. It goes out in maxChunks-sized spans: as one request it
         * exceeds the provider's per-request token limit, and the whole tail is lost.
         */
        async flush(meetingId) {
            const state = meetings.get(meetingId);
            meetings.delete(meetingId);
            if (!state || !state.buffer.length) return [];

            const out = [];
            for (let i = 0; i < state.buffer.length; i += maxChunks) {
                const span = state.buffer.slice(i, i + maxChunks);
                const text = await narrate(span);
                // a span that fails is dropped, not retried: the rest of the meeting still indexes
                if (!text) continue;
                const ordinal = await ordinalFor(meetingId, state);
                out.push(buildChunk(span, ordinal, text));
                state.ordinal = ordinal + 1;
            }
            return out;
        },

        pending(meetingId) {
            const state = meetings.get(meetingId);
            return state ? state.buffer.length : 0;
        },

        active() {
            return meetings.size;
        },
    };
}

module.exports = { createNarrator, NARRATE_PROMPT };
