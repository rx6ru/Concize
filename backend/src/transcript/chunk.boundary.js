// Decides where one retrievable chunk ends and the next begins.
// Boundaries come from speaker change + silence gap + semantic shift (soft), or hitting
// the token/duration cap (hard). Chunks overlap slightly so a boundary can't split a sentence.

'use strict';

const DEFAULTS = {
    maxDurationMs: 90000,
    maxTokens: 800,
    minDurationMs: 10000,      // below this, a soft signal is ignored: fragments retrieve badly
    silenceGapMs: 700,
    overlapRatio: 0.15,        // fraction of the closed chunk carried into the next
    semanticShiftThreshold: 0.35,
    startOrdinal: 0,          // resumed meetings carry on from the last stored chunk
};

// How much of a chunk has to be contested before the chunk is called overlapped.
//
// This used to be "any turn in the chunk was flagged", which only survived because the detector
// behind it caught almost nothing. Roughly a tenth of meeting speech is genuinely overlapped, so
// once detection works, a 90-second chunk of a four-person meeting nearly always contains some —
// and flagging every chunk means the model hedges every answer, which is exactly as useless as
// hedging none of them. A quarter is around 2.5x the base rate: a passage people actually talked
// over, not a passage containing one crossed word.
const CONTESTED_FLOOR = 0.25;

// Rough token estimate, not a real tokenizer call. Runs per utterance on the live path and
// a ~15% error only shifts a boundary slightly.
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

function cosineDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Accumulates utterances and emits closed chunks.
 *
 * @param {object} [opts] see DEFAULTS
 * @returns {{ add: function, flush: function, pending: function }}
 */
function createChunker(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    let buffer = [];
    let tokens = 0;
    let ordinal = cfg.startOrdinal;

    const spanMs = () => (buffer.length ? buffer[buffer.length - 1].t1Ms - buffer[0].t0Ms : 0);

    /** Share of a chunk's speech that was contested, weighted by how long each turn ran. */
    function contestedShare() {
        let overlapped = 0;
        let total = 0;
        for (const u of buffer) {
            const ms = Math.max(0, (u.t1Ms ?? 0) - (u.t0Ms ?? 0));
            if (!ms) continue;
            // Fusion records a per-turn ratio; fall back to the flag for anything older.
            const share = u.overlapRatio ?? (u.overlap ? 1 : 0);
            overlapped += share * ms;
            total += ms;
        }
        return total ? overlapped / total : 0;
    }

    function close(reason) {
        if (!buffer.length) return null;

        const contested = contestedShare();
        const chunk = {
            ordinal: ordinal++,
            t0Ms: buffer[0].t0Ms,
            t1Ms: buffer[buffer.length - 1].t1Ms,
            text: buffer.map((u) => u.text).join(' '),
            turnIds: buffer.map((u) => u.turnId),
            speakers: [...new Set(buffer.map((u) => u.speakerLabel).filter(Boolean))],
            hasOverlap: contested >= CONTESTED_FLOOR,
            contestedShare: Number(contested.toFixed(3)),
            tokens,
            reason,
        };

        // Carry a tail of the closed chunk into the next one so a boundary cannot split
        // a question from its answer.
        const carry = Math.floor(buffer.length * cfg.overlapRatio);
        buffer = carry > 0 ? buffer.slice(-carry) : [];
        tokens = buffer.reduce((n, u) => n + estimateTokens(u.text), 0);

        return chunk;
    }

    return {
        /**
         * Feed one finalised utterance. Returns a closed chunk, or null if the chunk is
         * still open. `embedding` is optional, without it the semantic signal is skipped
         * and boundaries rely on turn, silence and the hard cap.
         */
        add(utterance, embedding = null) {
            const prev = buffer[buffer.length - 1];
            const prevEmbedding = prev ? prev._embedding : null;

            // Evaluate the soft signals against the utterance about to be appended,
            // so the boundary falls BEFORE it rather than after.
            let closed = null;
            if (buffer.length && spanMs() >= cfg.minDurationMs) {
                const turnChanged = prev.speakerLabel !== utterance.speakerLabel;
                const gap = utterance.t0Ms - prev.t1Ms;
                const shifted = embedding && prevEmbedding
                    ? cosineDistance(prevEmbedding, embedding) > cfg.semanticShiftThreshold
                    : false;

                if (turnChanged && gap >= cfg.silenceGapMs && (shifted || !embedding)) {
                    closed = close('soft');
                }
            }

            buffer.push({ ...utterance, _embedding: embedding });
            tokens += estimateTokens(utterance.text);

            // Hard cap wins over everything, including an empty soft signal.
            if (tokens >= cfg.maxTokens || spanMs() >= cfg.maxDurationMs) {
                return close('hard') || closed;
            }
            return closed;
        },

        /**
         * Patch an utterance still sitting in the open buffer, after a correction. Without this
         * a late speaker label never reaches the chunk, and dropping the buffer instead would
         * lose the text entirely.
         */
        revise(turnId, changes) {
            const hit = buffer.find((u) => u.turnId === turnId);
            if (!hit) return false;

            const textChanged = changes.text !== undefined && changes.text !== hit.text;
            Object.assign(hit, changes);
            if (textChanged) {
                tokens = buffer.reduce((sum, u) => sum + estimateTokens(u.text), 0);
            }
            return true;
        },

        /** Close whatever is open, e.g. at end of meeting. */
        flush() {
            const chunk = close('flush');
            buffer = [];
            tokens = 0;
            return chunk;
        },

        pending() {
            return { utterances: buffer.length, tokens, spanMs: spanMs() };
        },
    };
}

module.exports = { createChunker, estimateTokens, cosineDistance, DEFAULTS };
