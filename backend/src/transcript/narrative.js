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
function createNarrator({ complete, model, minChunks = 4, maxChunks = 8, timeoutMs = 20000 }) {
    // One buffer per live meeting: { buffer: layer1Chunk[], ordinal: number }.
    const meetings = new Map();

    const stateFor = (meetingId) => {
        if (!meetings.has(meetingId)) meetings.set(meetingId, { buffer: [], ordinal: 0 });
        return meetings.get(meetingId);
    };

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
            // maxChunks forces an attempt even if minChunks has not been reached yet.
            if (state.buffer.length < minChunks && state.buffer.length < maxChunks) return null;

            const text = await narrate(state.buffer);
            if (!text) {
                // a provider outage must not keep growing the buffer for the rest of the meeting
                if (state.buffer.length >= maxChunks) {
                    logger.warn('Dropping narrative span after repeated failures',
                        { meetingId, chunks: state.buffer.length });
                    state.buffer = [];
                }
                return null;
            }

            const chunk = buildChunk(state.buffer, state.ordinal, text);
            state.ordinal += 1;
            state.buffer = [];
            return chunk;
        },

        /** Emit whatever is pending for a meeting, even below minChunks, and forget it. */
        async flush(meetingId) {
            const state = meetings.get(meetingId);
            if (!state || !state.buffer.length) {
                meetings.delete(meetingId);
                return null;
            }

            const text = await narrate(state.buffer);
            const chunk = text ? buildChunk(state.buffer, state.ordinal, text) : null;
            meetings.delete(meetingId);
            return chunk;
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
