// Composition root for the transcript write path.
// Wires up chunk boundaries, storage, embedding, and vector upsert. Embedding is coalesced
// per meeting: a running pass absorbs new chunks; a failed pass just costs freshness and retries next chunk.

'use strict';

const { getQdrant } = require('../infra/qdrant');
// The retrying variant: the provider caps embeds per minute, which a long meeting goes through
// in one pass, and a bare 429 leaves the chunk out of the index.
const { getEmbeddingWithRetry } = require('../providers/embedding/embedding.service');
const { getEmbeddings } = require('../providers/embedding/embedding.batch');
const { createChunkSearch } = require('../chat/chunk.search');
const { createDeriveService } = require('./derive.service');
const { createEmbedWorker } = require('./embed.worker');
const { createNarrator } = require('./narrative');
const { createRecorder } = require('../realtime/recorder');
const { createReconciler } = require('./reconcile.wiring');
const { getSummaryInference } = require('../providers/llm/inference.provider');
const {
    insertChunk, markDirtyForRange, getDirtyChunks, getUnembedded, attachVector, nextOrdinal,
} = require('./chunk.repository');
const { appendUtterance, reviseUtterance } = require('./utterance.repository');
const { getMeetingOwner, appendTranscription } = require('../meetings/meeting.repository');
const { completeMeeting } = require('../meetings/meeting.service');
const { getMeetingSummary } = require('../summary/summary.repository');
const { publishToQueue } = require('../infra/queue');
const config = require('../core/config');
const { ledger } = require('../core/usage.ledger');
const { createLogger } = require('../core/logger');

const logger = createLogger('transcriptPipeline');

// Spools the meeting to disk so the post-meeting batch pass has something to re-transcribe.
// Off by default: a three hour meeting is about 345 MB of wav.
const recorder = process.env.RECORDING_DIR
    ? createRecorder({ dir: process.env.RECORDING_DIR })
    : null;

function onFrame(meetingId, frame) {
    if (recorder) recorder.write(meetingId, frame);
}

const loadRecording = (meetingId) => (recorder ? recorder.load(meetingId) : Promise.resolve(null));
const discardRecording = (meetingId) => (recorder ? recorder.discard(meetingId) : Promise.resolve(false));

// Only exists when there is a recording to reconcile against.
const reconciler = recorder ? createReconciler({ loadRecording, discardRecording }) : null;

let parts = null;

function build() {
    const index = createChunkSearch({ client: getQdrant(), embed: getEmbeddingWithRetry });

    const embedWorker = createEmbedWorker({
        getUnembedded,
        getDirtyChunks,
        attachVector,
        embed: getEmbeddingWithRetry,
        // Batched: a pass is one request instead of one per chunk, which is what put long
        // meetings past the provider's per-minute request ceiling mid-pass.
        embedMany: getEmbeddings,
        upsert: index.upsert,
    });

    // Layer 2 is prose covering a run of layer-1 chunks, so an abstract question matches
    // narrative rather than raw disfluent speech. Same provider the summary uses.
    const narrator = createNarrator({
        complete: async (args) => {
            const { client, model, taskConfig } = getSummaryInference();
            const res = await client.chat.completions.create({ ...args, model });
            // Narration is the largest LLM consumer in the system — a full corpus ingest costs
            // about a day's token budget on its own — so it is the one that most needs counting.
            ledger.record(taskConfig.provider, model, res?.usage?.total_tokens || 0);
            return res;
        },
        model: null,
        nextOrdinal,
    });

    const derive = createDeriveService({
        insertChunk,
        markDirtyForRange,
        nextOrdinal,
        onChunk: (meetingId, chunk) => {
            scheduleEmbed(meetingId);
            queueForSummary(meetingId, chunk);
            narrate(meetingId, chunk);
        },
    });

    return { index, embedWorker, derive, narrator };
}

function get() {
    if (!parts) parts = build();
    return parts;
}

// The title comes from the summary and changes as the meeting progresses, so it is read per
// pass rather than cached. The owner is what keeps a vector out of another tenant's search.
async function meetingMeta(meetingId) {
    const [ownerId, summary] = await Promise.all([
        getMeetingOwner(meetingId).catch(() => null),
        getMeetingSummary(meetingId).catch(() => null),
    ]);
    return { ownerId, title: summary?.title || null };
}

const inFlight = new Map();

/**
 * Embeds everything outstanding for a meeting. Concurrent calls collapse into the running
 * pass, which then repeats once if more work arrived while it ran.
 */
function scheduleEmbed(meetingId) {
    const current = inFlight.get(meetingId);
    if (current) {
        current.again = true;
        return current.promise;
    }

    const entry = { again: false };
    entry.promise = (async () => {
        try {
            do {
                entry.again = false;
                // A pass reads a bounded batch, so a long meeting's backlog needs several.
                // Stop as soon as one makes no progress, or a chunk that always fails spins here.
                let embedded;
                do {
                    ({ embedded } = await get().embedWorker.run(meetingId, await meetingMeta(meetingId)));
                } while (embedded > 0);
            } while (entry.again);
        } catch (err) {
            logger.error('Embed pass failed', { meetingId, error: err.message });
        } finally {
            inFlight.delete(meetingId);
        }
    })();

    inFlight.set(meetingId, entry);
    return entry.promise;
}

/**
 * Hands a finished chunk to the summary worker.
 *
 * The worker reads transcription_chunks by index, which is how the old batch path fed it, so the
 * live path appends there too rather than the worker growing a second input. Failing here costs
 * a stale summary, not the meeting.
 */
async function queueForSummary(meetingId, chunk) {
    try {
        const { success, chunkIndex } = await appendTranscription(meetingId, chunk.text);
        if (!success) return;
        await publishToQueue(config.queues.SUMMARY_QUEUE, { jobId: meetingId, chunkIndex, isLastChunk: false });
    } catch (err) {
        logger.error('Summary enqueue failed', { meetingId, error: err.message });
    }
}

/** Stores a layer-2 narrative chunk once enough layer-1 chunks have accumulated. */
async function narrate(meetingId, chunk) {
    try {
        const layer2 = await get().narrator.add(meetingId, chunk);
        if (layer2) {
            await insertChunk(meetingId, layer2);
            scheduleEmbed(meetingId);
        }
    } catch (err) {
        logger.error('Narrative chunk failed', { meetingId, error: err.message });
    }
}

// The gateway's event shape is the wire shape; the log's is the storage shape.
function toUtterance(event) {
    return {
        turnId: String(event.turnId ?? event.t0Ms),
        t0Ms: event.t0Ms,
        t1Ms: event.t1Ms,
        text: event.text,
        speakerLabel: event.speakerLabel ?? null,
        speakerConfidence: event.speakerConfidence ?? 'unknown',
        overlap: event.overlap ?? false,
        overlapRatio: event.overlapRatio ?? 0,
    };
}

/** Creates the vector collection if it is missing. Called once at startup. */
async function ensureReady() {
    try {
        await get().index.ensureCollection();
    } catch (err) {
        // Retrieval degrades; transcription does not. The collection is retried on first write.
        logger.error('Chunk collection unavailable', { error: err.message });
    }
}

async function onUtterance(meetingId, event) {
    const utterance = toUtterance(event);
    await appendUtterance(meetingId, utterance);
    await get().derive.ingest(meetingId, utterance);
}

async function onRevision(meetingId, event) {
    const utterance = toUtterance(event);
    await reviseUtterance(meetingId, utterance.turnId, utterance);
    await get().derive.onUtteranceRevised(meetingId, utterance);
}

/** Closes the open chunk at end of meeting and indexes whatever is left. */
async function onSessionEnd(meetingId) {
    if (recorder) {
        const rec = await recorder.close(meetingId);
        if (rec) logger.info('Recording saved', { meetingId, durationMs: rec.durationMs, bytes: rec.bytes });
    }

    await get().derive.finish(meetingId);

    try {
        for (const layer2 of await get().narrator.flush(meetingId)) {
            await insertChunk(meetingId, layer2);
        }
    } catch (err) {
        logger.error('Final narrative chunk failed', { meetingId, error: err.message });
    }

    await scheduleEmbed(meetingId);

    // Nothing else advanced this, so every meeting sat at in-progress forever.
    try {
        await completeMeeting(meetingId);
    } catch (err) {
        logger.warn('Could not mark the meeting complete', { meetingId, error: err.message });
    }

    // Through the queue, not a direct call: the last chunk may still be summarising, and its
    // save would flip the status back to updating.
    try {
        await publishToQueue(config.queues.SUMMARY_QUEUE, { jobId: meetingId, finalise: true });
    } catch (err) {
        logger.warn('Could not finalise summary', { meetingId, error: err.message });
    }

    // Batch re-transcription takes minutes, so it runs behind the session teardown rather
    // than holding the socket close open.
    if (reconciler) {
        reconciler.run(meetingId).catch((err) =>
            logger.error('Reconcile pass failed', { meetingId, error: err.message }));
    }
}

/** Test seam. */
function _resetForTests() {
    parts = null;
    inFlight.clear();
}

module.exports = {
    ensureReady,
    onFrame,
    loadRecording,
    discardRecording,
    reconcile: (meetingId) => (reconciler ? reconciler.run(meetingId) : Promise.resolve(null)),
    onUtterance,
    onRevision,
    onSessionEnd,
    scheduleEmbed,
    _resetForTests,
};
