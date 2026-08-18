// Drives the post-meeting reconciliation pass.
//   stored audio → segments (≤2h) → batch transcribe+diarize → stitch → align → revisions
// Everything it produces is a correction to an existing transcript, so on any doubt it leaves the live version alone.

'use strict';

const { planSegments, stitchSegments } = require('./reconcile.segments');
const { align } = require('./reconcile.aligner');
const { createLogger } = require('../core/logger');

const logger = createLogger('reconcileWorker');

/**
 * @param {object} deps
 * @param {function} deps.loadAudio        (meetingId) => {buffer, durationMs}
 * @param {function} deps.sliceAudio       (buffer, t0Ms, t1Ms) => buffer
 * @param {function} deps.transcribeBatch  (buffer, meta) => raw provider result
 * @param {function} deps.getTranscript    (meetingId) => live utterances
 * @param {function} deps.reviseUtterance  (meetingId, turnId, changes) => row
 * @param {function} [deps.markDirtyForRange]
 */
function createReconcileWorker({
    loadAudio, sliceAudio, transcribeBatch, getTranscript, reviseUtterance, markDirtyForRange = null,
}) {

    // Providers vary in how they name diarized output; normalise once, here.
    function toEntries(result) {
        const d = result?.diarized_transcript;
        const raw = Array.isArray(d) ? d : d?.entries;
        if (!Array.isArray(raw)) return [];
        return raw.map((e) => ({
            t0Ms: Math.round((e.start_time_seconds ?? e.start_s ?? 0) * 1000),
            t1Ms: Math.round((e.end_time_seconds ?? e.end_s ?? 0) * 1000),
            text: e.transcript ?? e.text ?? '',
            speakerId: e.speaker_id ?? e.speaker ?? null,
        }));
    }

    return {
        async run(meetingId) {
            const { buffer, durationMs } = await loadAudio(meetingId);
            const segments = planSegments(durationMs);
            if (!segments.length) {
                logger.warn('Nothing to reconcile', { meetingId, durationMs });
                return { applied: 0, unmatched: 0, failedSegments: 0, skipped: true };
            }

            const results = [];
            const failedRanges = [];

            for (const segment of segments) {
                try {
                    const slice = await sliceAudio(buffer, segment.t0Ms, segment.t1Ms);
                    const raw = await transcribeBatch(slice, {
                        originalFileName: `${meetingId}-seg${segment.index}.wav`,
                        mimetype: 'audio/wav',
                    });
                    results.push({ segment, entries: toEntries(raw) });
                } catch (err) {
                    // Keep going: a lost segment costs corrections in that window only.
                    failedRanges.push(segment);
                    logger.error('Segment failed, leaving that span as-is', {
                        meetingId, segment: segment.index, error: err.message,
                    });
                }
            }

            if (!results.length) {
                logger.error('All segments failed; transcript unchanged', { meetingId });
                return { applied: 0, unmatched: 0, failedSegments: failedRanges.length, skipped: true };
            }

            const { entries } = stitchSegments(results);
            const live = await getTranscript(meetingId);

            // A turn inside a failed window has no batch evidence, so aligning it would read as "batch heard nothing" and wrongly flag it.
            const inFailedWindow = (turn) =>
                failedRanges.some((s) => turn.t0Ms < s.t1Ms && s.t0Ms < turn.t1Ms);
            const alignable = live.filter((t) => !inFailedWindow(t));

            const { revisions, unmatched } = align(alignable, entries);

            let applied = 0;
            for (const revision of revisions) {
                try {
                    await reviseUtterance(meetingId, revision.turnId, revision);
                    if (markDirtyForRange) {
                        await markDirtyForRange(meetingId, revision.t0Ms, revision.t1Ms);
                    }
                    applied += 1;
                } catch (err) {
                    logger.error('Revision failed', {
                        meetingId, turnId: revision.turnId, error: err.message,
                    });
                }
            }

            logger.info('Reconciliation complete', {
                meetingId, segments: segments.length, failedSegments: failedRanges.length,
                revisions: revisions.length, applied, unmatched: unmatched.length,
            });

            return {
                applied,
                proposed: revisions.length,
                unmatched: unmatched.length,
                failedSegments: failedRanges.length,
                skipped: false,
            };
        },
    };
}

module.exports = { createReconcileWorker };
