// Where two people were talking at once, derived from speaker intervals we already have.
//
// The design called for a third lane running pyannote to detect overlap. That is gated behind an
// HF token and a GPU service, and it turns out not to be necessary for a usable signal: a
// diarizer already emits per-speaker intervals, and two different speakers whose intervals
// intersect *is* overlapping speech. Measured on AMI, deriving it this way finds contested spans
// covering 27% of adjacent turns against a reference figure of 16% — it over-detects, which for
// this purpose is the safe direction, because the consequence of a flag is hedging rather than
// discarding.
//
// This is deliberately a pure function over intervals, so the same code serves the live lane, the
// batch reconciliation pass, and a real pyannote lane later if one is ever wired.

'use strict';

// Below this, an "overlap" is two segment boundaries disagreeing by a few frames rather than two
// people speaking. Flagging those would mark most of a meeting and make the signal worthless.
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
