// Joins the words, speaker, and overlap lanes on the session timeline into finalised utterances.
// Text is never held back waiting for a speaker: words outrank speakers outrank overlap, so a
// dead speaker lane costs attribution, not transcription. Late data just produces a revision.

'use strict';

const { deriveOverlaps } = require('../transcript/overlap.derive');

const CONFIDENCE = { CONFIDENT: 'confident', PROVISIONAL: 'provisional', UNKNOWN: 'unknown' };

// Sarvam gives segment-level timestamps, not word-level, so we use the midpoint as the
// best guess for which speaker owns this span. anything fancier would imply precision
// we don't actually have.
function speakerAt(intervals, t0Ms, t1Ms) {
    const mid = (t0Ms + t1Ms) / 2;
    let best = null;
    for (const iv of intervals) {
        if (iv.t0Ms <= mid && mid < iv.t1Ms) {
            if (!best || iv.t1Ms - iv.t0Ms < best.t1Ms - best.t0Ms) best = iv; // tightest wins
        }
    }
    return best;
}

// union of overlap intervals clipped to [t0,t1], as a fraction of the span.
// using union instead of sum, otherwise two overlapping intervals could report over 100%.
function overlapRatio(intervals, t0Ms, t1Ms) {
    const span = t1Ms - t0Ms;
    if (span <= 0) return 0;

    const clipped = intervals
        .map((iv) => [Math.max(iv.t0Ms, t0Ms), Math.min(iv.t1Ms, t1Ms)])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);

    let covered = 0;
    let cursor = -Infinity;
    for (const [a, b] of clipped) {
        const start = Math.max(a, cursor);
        if (b > start) {
            covered += b - start;
            cursor = b;
        }
    }
    return Math.min(1, covered / span);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.overlapThreshold] fraction of the span that counts as overlapped
 * @param {number} [opts.retentionMs]      how far back lane intervals are kept for late joins
 */
function createFusion({ overlapThreshold = 0.15, retentionMs = 60000 } = {}) {
    const speakers = [];
    const overlaps = [];
    const fused = new Map();   // turnId -> last emitted utterance, for late revision

    const prune = (now) => {
        const cutoff = now - retentionMs;
        for (const list of [speakers, overlaps]) {
            while (list.length && list[0].t1Ms < cutoff) list.shift();
        }
    };

    function build(words) {
        const { turnId, t0Ms, t1Ms, text } = words;
        const spk = speakerAt(speakers, t0Ms, t1Ms);
        const ratio = overlapRatio(overlaps, t0Ms, t1Ms);
        const overlap = ratio > overlapThreshold;

        let confidence;
        if (!spk) confidence = CONFIDENCE.UNKNOWN;
        else if (overlap || spk.confidence === CONFIDENCE.PROVISIONAL) confidence = CONFIDENCE.PROVISIONAL;
        else confidence = spk.confidence || CONFIDENCE.CONFIDENT;

        return {
            turnId, t0Ms, t1Ms, text,
            speakerLabel: spk ? spk.speakerLabel : null,
            speakerConfidence: confidence,
            overlap,
            overlapRatio: Number(ratio.toFixed(3)),
        };
    }

    return {
        addSpeakerInterval(iv) {
            speakers.push(iv);
            prune(iv.t1Ms);

            // Two different speakers whose intervals intersect were talking at once. Deriving it
            // here means the overlap signal exists without a separate detector; a real overlap
            // lane, if one is ever wired, simply adds better intervals through the same door.
            for (const span of deriveOverlaps(speakers)) {
                const known = overlaps.some((o) => o.t0Ms === span.t0Ms && o.t1Ms === span.t1Ms);
                if (!known) overlaps.push(span);
            }
            prune(iv.t1Ms);
        },

        addOverlapInterval(iv) {
            overlaps.push(iv);
            prune(iv.t1Ms);
        },

        /** Emit immediately with whatever the other lanes have supplied so far. */
        fuse(words) {
            const utterance = build(words);
            fused.set(words.turnId, utterance);
            return utterance;
        },

        /**
         * Re-evaluate already-emitted utterances after late lane data.
         * Returns only those whose attribution actually changed, so callers can emit
         * revisions without republishing the whole transcript.
         */
        revise() {
            const changed = [];
            for (const [turnId, prev] of fused) {
                const next = build(prev);
                if (next.speakerLabel !== prev.speakerLabel
                    || next.speakerConfidence !== prev.speakerConfidence
                    || next.overlap !== prev.overlap) {
                    fused.set(turnId, next);
                    changed.push(next);
                }
            }
            return changed;
        },

        stats() {
            return { speakers: speakers.length, overlaps: overlaps.length, fused: fused.size };
        },
    };
}

module.exports = { createFusion, speakerAt, overlapRatio, CONFIDENCE };
