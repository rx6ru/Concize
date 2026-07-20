// Runs the post-meeting reconciliation pass once a meeting ends.
// Needs a recording, so it only runs when RECORDING_DIR is set. Everything it does is a
// correction to an existing transcript, so a failure leaves the live version as it is.

'use strict';

const { createReconcileWorker } = require('./reconcile.worker');
const { sliceAudio } = require('../realtime/recorder');
const { transcribeBatch } = require('../providers/stt/sarvam.batch');
const { getTranscript, reviseUtterance } = require('./utterance.repository');
const { markDirtyForRange } = require('./chunk.repository');
const { createLogger } = require('../core/logger');

const logger = createLogger('reconcileWiring');

const KEEP_RECORDING = process.env.KEEP_RECORDING === 'true';

/**
 * @param {object} deps
 * @param {function} deps.loadRecording     (meetingId) => {buffer, durationMs} or null
 * @param {function} deps.discardRecording  (meetingId) => boolean
 */
function createReconciler({ loadRecording, discardRecording }) {
    const worker = createReconcileWorker({
        loadAudio: loadRecording,
        sliceAudio: (buffer, t0Ms, t1Ms) => sliceAudio(buffer, t0Ms, t1Ms),
        transcribeBatch,
        getTranscript,
        reviseUtterance,
        markDirtyForRange,
    });

    return {
        /** Reconcile one meeting. Returns the worker's result, or null if there was nothing to do. */
        async run(meetingId) {
            const recording = await loadRecording(meetingId);
            if (!recording) return null;

            try {
                const result = await worker.run(meetingId);
                logger.info('Reconciled', { meetingId, ...result });
                return result;
            } catch (err) {
                logger.error('Reconciliation failed, transcript left as-is',
                    { meetingId, error: err.message });
                return null;
            } finally {
                // The recording is only needed for this pass. Hours of wav per meeting adds up.
                if (!KEEP_RECORDING) await discardRecording(meetingId);
            }
        },
    };
}

module.exports = { createReconciler };
