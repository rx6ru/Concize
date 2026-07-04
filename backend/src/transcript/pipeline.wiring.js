// Composition root for the transcript write path.
// Wires up chunk boundaries, storage, embedding, and vector upsert. Embedding is coalesced
// per meeting: a running pass absorbs new chunks; a failed pass just costs freshness and retries next chunk.

'use strict';

const { getQdrant } = require('../infra/qdrant');
const { getEmbedding } = require('../providers/embedding/embedding.service');
const { createChunkSearch } = require('../chat/chunk.search');
const { createDeriveService } = require('./derive.service');
const { createEmbedWorker } = require('./embed.worker');
const {
    insertChunk, markDirtyForRange, getDirtyChunks, getUnembedded, attachVector,
} = require('./chunk.repository');
const { appendUtterance, reviseUtterance } = require('./utterance.repository');
const { getMeetingOwner } = require('../meetings/meeting.repository');
const { getMeetingSummary } = require('../summary/summary.repository');
const { createLogger } = require('../core/logger');

const logger = createLogger('transcriptPipeline');

let parts = null;

function build() {
    const index = createChunkSearch({ client: getQdrant(), embed: getEmbedding });

    const embedWorker = createEmbedWorker({
        getUnembedded,
        getDirtyChunks,
        attachVector,
        embed: getEmbedding,
        upsert: index.upsert,
    });

    const derive = createDeriveService({
        insertChunk,
        markDirtyForRange,
        onChunk: (meetingId) => { scheduleEmbed(meetingId); },
    });

    return { index, embedWorker, derive };
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
                await get().embedWorker.run(meetingId, await meetingMeta(meetingId));
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
    await get().derive.finish(meetingId);
    await scheduleEmbed(meetingId);
}

/** Test seam. */
function _resetForTests() {
    parts = null;
    inFlight.clear();
}

module.exports = {
    ensureReady,
    onUtterance,
    onRevision,
    onSessionEnd,
    scheduleEmbed,
    _resetForTests,
};
