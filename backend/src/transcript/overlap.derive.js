// Where two people were talking at once, derived from speaker intervals crossing. A stopgap, measured weak: precision 32.9%, recall 18.9%, F1 23.6% against AMI ground truth (eval/overlap-accuracy.js, 3 meetings), vs 69.2% for pyannote segmentation-3.0 offline and 63.3% streaming through speaker-service/overlap.py, which is what ships.
// This is now the fallback, used only when the speaker service has no overlap model loaded.
// The gap is structural, not a tuning issue: a clustering backend gives each segment exactly one speaker, so overlap inside a segment is invisible to it.
// Pure function over intervals, so the same code serves the live lane, batch reconciliation, and a real pyannote lane later.

'use strict';

// Below this, an "overlap" is boundary disagreement by a few frames, not two people speaking. Flagging those would mark most of a meeting.
const MIN_OVERLAP_MS = 120;

/**
 * Contested spans, merged so one event is reported once.
 *
 * @param {Array<{t0Ms: number, t1Ms: number, speaker: ?string}>} intervals
 * @returns {Array<{t0Ms: number, t1Ms: number, speakers: string[]}>}
 */
function deriveOverlaps(intervals) {
    const usable = (intervals || [])
        .filter((i) => i && i.speaker != null && Number.isFinite(i.t0Ms) && Number.isFinite(i.t1Ms))
        .sort((a, b) => a.t0Ms - b.t0Ms);

    if (usable.length < 2) return [];

    const found = [];
    for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
            const a = usable[i];
            const b = usable[j];

            // Sorted by start, so once b starts after a ends, nothing later can intersect a.
            if (b.t0Ms >= a.t1Ms) break;
            if (a.speaker === b.speaker) continue;

            const t0Ms = Math.max(a.t0Ms, b.t0Ms);
            const t1Ms = Math.min(a.t1Ms, b.t1Ms);
            if (t1Ms - t0Ms < MIN_OVERLAP_MS) continue;

            found.push({ t0Ms, t1Ms, speakers: [a.speaker, b.speaker] });
        }
    }

    return mergeIntervals(found);
}

/** Joins spans that touch or overlap, unioning who was involved. */
function mergeIntervals(spans) {
    if (!spans.length) return [];
    const sorted = [...spans].sort((a, b) => a.t0Ms - b.t0Ms);

    const out = [{ ...sorted[0], speakers: [...sorted[0].speakers] }];
    for (const span of sorted.slice(1)) {
        const last = out[out.length - 1];
        if (span.t0Ms <= last.t1Ms) {
            last.t1Ms = Math.max(last.t1Ms, span.t1Ms);
            last.speakers = [...new Set([...last.speakers, ...span.speakers])];
        } else {
            out.push({ ...span, speakers: [...span.speakers] });
        }
    }
    return out;
}

module.exports = { deriveOverlaps, mergeIntervals, MIN_OVERLAP_MS };
