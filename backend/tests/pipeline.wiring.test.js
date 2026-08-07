// Write path wired the way production wires it: real derive service, chunker, embed worker,
// chunk-search adapter. Only Postgres, Qdrant and the embedding provider are faked.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const store = {
    chunks: [],
    dirtyRanges: [],
    utterances: [],
    revisions: [],
};

jest.mock('../src/transcript/chunk.repository', () => ({
    insertChunk: jest.fn(async (meetingId, chunk) => {
        const stored = { meetingId, rev: 0, vectorId: null, dirty: false, ...chunk };
        store.chunks.push(stored);
        return stored;
    }),
    markDirtyForRange: jest.fn(async (meetingId, t0Ms, t1Ms) => {
        store.dirtyRanges.push({ meetingId, t0Ms, t1Ms });
    }),
    // Both the meeting scope and the limit are what the real queries apply. Ignoring the limit
    // hid a backlog that never drained; ignoring the meeting made two meetings patch each other.
    getUnembedded: jest.fn(async (meetingId, { limit = 100 } = {}) =>
        store.chunks.filter((c) => c.meetingId === meetingId && !c.vectorId).slice(0, limit)),
    getDirtyChunks: jest.fn(async (meetingId, { limit = 100 } = {}) =>
        store.chunks.filter((c) => c.meetingId === meetingId && c.dirty).slice(0, limit)),
    attachVector: jest.fn(async (meetingId, chunk, vectorId) => {
        const hit = store.chunks.find((c) => c.meetingId === meetingId
            && c.layer === chunk.layer && c.ordinal === chunk.ordinal);
        hit.vectorId = vectorId;
        hit.dirty = false;
        return hit;
    }),
}));

jest.mock('../src/transcript/utterance.repository', () => ({
    appendUtterance: jest.fn(async (meetingId, u) => { store.utterances.push({ meetingId, ...u }); }),
    reviseUtterance: jest.fn(async (meetingId, turnId, u) => { store.revisions.push({ meetingId, turnId, ...u }); }),
}));

jest.mock('../src/meetings/meeting.service', () => ({
    completeMeeting: jest.fn(async () => true),
    completeMeetingWithErrors: jest.fn(async () => true),
}));

jest.mock('../src/meetings/meeting.repository', () => ({
    getMeetingOwner: jest.fn(async () => 'user-A'),
    appendTranscription: jest.fn(async () => ({ success: true, chunkIndex: store.chunks.length - 1 })),
}));

jest.mock('../src/infra/queue', () => ({ publishToQueue: jest.fn(async () => {}) }));

// without this the narrator reaches for a real provider and the suite hits the network
jest.mock('../src/providers/llm/inference.provider', () => ({
    getSummaryInference: () => ({
        client: { chat: { completions: { create: jest.fn(async () => ({
            choices: [{ message: { content: 'S1 said they should revisit pricing.' } }],
        })) } } },
        model: 'test-model',
    }),
}));

jest.mock('../src/summary/summary.repository', () => ({
    getMeetingSummary: jest.fn(async () => ({ title: 'Q3 planning' })),
}));

const upserted = [];
jest.mock('../src/infra/qdrant', () => ({
    getQdrant: () => ({
        getCollections: jest.fn(async () => ({ collections: [] })),
        createCollection: jest.fn(async () => {}),
        createPayloadIndex: jest.fn(async () => {}),
        upsert: jest.fn(async (collection, { points }) => { upserted.push(...points); }),
    }),
}));

jest.mock('../src/providers/embedding/embedding.service', () => ({
    getEmbedding: jest.fn(async () => new Array(768).fill(0.1)),
    getEmbeddingWithRetry: jest.fn(async () => new Array(768).fill(0.1)),
}));

// One vector per text, in order — the real contract. A fake returning a single vector, or
// ignoring the count, would hide exactly the misalignment the real one refuses to produce.
jest.mock('../src/providers/embedding/embedding.batch', () => ({
    getEmbeddings: jest.fn(async (texts) => texts.map(() => new Array(768).fill(0.1))),
}));

const pipeline = require('../src/transcript/pipeline.wiring');
const { insertChunk, markDirtyForRange, attachVector } = require('../src/transcript/chunk.repository');
const { appendUtterance, reviseUtterance } = require('../src/transcript/utterance.repository');
const { getEmbeddingWithRetry: getEmbedding } = require('../src/providers/embedding/embedding.service');
const { getEmbeddings } = require('../src/providers/embedding/embedding.batch');
const { appendTranscription } = require('../src/meetings/meeting.repository');
const { publishToQueue } = require('../src/infra/queue');
const { completeMeeting } = require('../src/meetings/meeting.service');

const utterance = (over = {}) => ({
    turnId: 1, t0Ms: 0, t1Ms: 2000, text: 'we should revisit pricing', ...over,
});

beforeEach(() => {
    store.chunks.length = 0;
    store.dirtyRanges.length = 0;
    store.utterances.length = 0;
    store.revisions.length = 0;
    upserted.length = 0;
    jest.clearAllMocks();
    // clearAllMocks resets call counts but not implementations, so a rejection set by one test
    // would otherwise leak into the next.
    getEmbedding.mockReset().mockResolvedValue(new Array(768).fill(0.1));
    getEmbeddings.mockReset().mockImplementation(async (texts) => texts.map(() => new Array(768).fill(0.1)));
    pipeline._resetForTests();
});

describe('ingestion', () => {
    it('persists the utterance before deriving from it', async () => {
        await pipeline.onUtterance('m1', utterance());

        expect(appendUtterance).toHaveBeenCalledWith('m1', expect.objectContaining({
            turnId: '1', text: 'we should revisit pricing',
        }));
    });

    it('normalises the wire shape into the storage shape', async () => {
        await pipeline.onUtterance('m1', utterance({ turnId: 7, speakerLabel: 'S2' }));

        expect(store.utterances[0]).toMatchObject({
            turnId: '7',                    // string, matching the log's key type
            speakerLabel: 'S2',
            speakerConfidence: 'unknown',   // never invented
            overlap: false,
            overlapRatio: 0,
        });
    });

    it('falls back to the start time when a turn has no id', async () => {
        await pipeline.onUtterance('m1', { t0Ms: 4200, t1Ms: 5000, text: 'x' });
        expect(store.utterances[0].turnId).toBe('4200');
    });

    it('holds an utterance in the open chunk rather than storing it immediately', async () => {
        await pipeline.onUtterance('m1', utterance());
        expect(insertChunk).not.toHaveBeenCalled();
    });
});

describe('revision', () => {
    it('revises the log and marks the covered span dirty', async () => {
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');
        await pipeline.onRevision('m1', utterance({ speakerLabel: 'S3' }));

        expect(reviseUtterance).toHaveBeenCalledWith('m1', '1', expect.objectContaining({ speakerLabel: 'S3' }));
        expect(markDirtyForRange).toHaveBeenCalledWith('m1', 0, 2000);
    });
});

describe('end of meeting', () => {
    it('stores the chunk still open when the session ends', async () => {
        await pipeline.onUtterance('m1', utterance());
        expect(store.chunks).toHaveLength(0);

        await pipeline.onSessionEnd('m1');

        expect(store.chunks.filter((c) => c.layer === 1)).toHaveLength(1);
        expect(store.chunks[0]).toMatchObject({ layer: 1, text: 'we should revisit pricing' });
    });

    it('embeds and indexes what it stored', async () => {
        await pipeline.onUtterance('m1', utterance({ speakerLabel: 'S1' }));
        await pipeline.onSessionEnd('m1');

        expect(upserted.filter((u) => u.payload.layer === 1)).toHaveLength(1);
        expect(upserted[0].payload).toMatchObject({
            meetingId: 'm1',
            ownerId: 'user-A',      // tenant isolation reaches the vector layer
            layer: 1,
            speakers: ['S1'],
        });
    });

    it('embeds the chunk with its situating context, not the bare text', async () => {
        await pipeline.onUtterance('m1', utterance({ speakerLabel: 'S1' }));
        await pipeline.onSessionEnd('m1');

        const embedded = getEmbeddings.mock.calls[0][0].find((t) => t.includes('we should revisit'));
        expect(embedded).toContain('Q3 planning');
        expect(embedded).toContain('Speakers: S1');
        expect(embedded).toContain('we should revisit pricing');
    });

    it('records the vector id only after the upsert succeeds', async () => {
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(attachVector).toHaveBeenCalled();
        expect(store.chunks[0].vectorId).toBe(upserted[0].id);
    });

    it('is idempotent — a second end does not store an empty chunk', async () => {
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');
        await pipeline.onSessionEnd('m1');

        expect(store.chunks.filter((c) => c.layer === 1)).toHaveLength(1);
    });
});

describe('embedding passes', () => {
    it('collapses concurrent triggers into one pass', async () => {
        store.chunks.push({ meetingId: 'm1', layer: 1, ordinal: 0, rev: 0, t0Ms: 0, t1Ms: 1000, text: 'a', speakers: [] });

        await Promise.all([
            pipeline.scheduleEmbed('m1'),
            pipeline.scheduleEmbed('m1'),
            pipeline.scheduleEmbed('m1'),
        ]);

        // One vector, not three: the later calls joined the running pass.
        expect(upserted).toHaveLength(1);
    });

    // A pass reads at most batchSize chunks. A long meeting ends with a bigger backlog than
    // that, and the single closing pass used to leave the remainder out of the index forever.
    it('drains a backlog larger than one pass', async () => {
        for (let i = 0; i < 80; i++) {
            store.chunks.push({
                meetingId: 'm1', layer: 1, ordinal: i, rev: 0,
                t0Ms: i * 1000, t1Ms: i * 1000 + 900, text: `line ${i}`, speakers: [], vectorId: null,
            });
        }

        await pipeline.scheduleEmbed('m1');

        expect(store.chunks.filter((c) => !c.vectorId)).toHaveLength(0);
        expect(upserted).toHaveLength(80);
    });

    it('stops draining instead of spinning when every chunk fails', async () => {
        getEmbeddings.mockRejectedValue(new Error('provider down'));
        for (let i = 0; i < 80; i++) {
            store.chunks.push({
                meetingId: 'm1', layer: 1, ordinal: i, rev: 0,
                t0Ms: i * 1000, t1Ms: i * 1000 + 900, text: `line ${i}`, speakers: [], vectorId: null,
            });
        }

        await pipeline.scheduleEmbed('m1');

        expect(upserted).toHaveLength(0);
        expect(getEmbeddings.mock.calls.length).toBeLessThanOrEqual(80);
    });

    it('leaves a chunk unembedded when the provider is down, rather than marking it indexed', async () => {
        getEmbeddings.mockRejectedValue(new Error('provider down'));

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(store.chunks[0].vectorId).toBeNull();
        expect(attachVector).not.toHaveBeenCalled();
    });

    it('picks up a chunk that failed an earlier pass', async () => {
        getEmbeddings.mockRejectedValueOnce(new Error('transient'));

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(store.chunks[0].vectorId).not.toBeNull();
    });

    it('does not let an embedding failure escape into the meeting', async () => {
        getEmbeddings.mockRejectedValue(new Error('provider down'));
        await expect(pipeline.onUtterance('m1', utterance())).resolves.toBeUndefined();
        await expect(pipeline.onSessionEnd('m1')).resolves.toBeUndefined();
    });

    it('does not fail the meeting when the owner lookup is unavailable', async () => {
        require('../src/meetings/meeting.repository').getMeetingOwner
            .mockRejectedValueOnce(new Error('pg down'));

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(upserted[0].payload.ownerId).toBeNull();
    });
});

describe('summary handoff', () => {
    it('queues each derived chunk for summarisation', async () => {
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(appendTranscription).toHaveBeenCalledWith('m1', 'we should revisit pricing');
        expect(publishToQueue).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ jobId: 'm1', chunkIndex: expect.any(Number) })
        );
    });

    it('finalises the summary through the queue so it lands after the last chunk', async () => {
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(publishToQueue).toHaveBeenLastCalledWith(
            expect.any(String), { jobId: 'm1', finalise: true }
        );
    });

    it('does not publish when the append failed, so the worker never chases a missing chunk', async () => {
        appendTranscription.mockResolvedValueOnce({ success: false, chunkIndex: -1 });

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        // the finalise marker still goes out, but no chunk was announced
        expect(publishToQueue).not.toHaveBeenCalledWith(
            expect.any(String), expect.objectContaining({ chunkIndex: expect.anything() })
        );
    });

    it('does not fail the meeting when the queue is down', async () => {
        publishToQueue.mockRejectedValue(new Error('amqp gone'));

        await expect(pipeline.onUtterance('m1', utterance())).resolves.toBeUndefined();
        await expect(pipeline.onSessionEnd('m1')).resolves.toBeUndefined();
        expect(store.chunks.filter((c) => c.layer === 1)).toHaveLength(1);   // still stored
    });
});

describe('two meetings at once', () => {
    it('keeps chunks, summaries and vectors on the right meeting', async () => {
        // interleaved rather than sequential, since per-meeting state is keyed in Maps and a
        // regression that hoisted it out of the closure would only show up under interleaving
        await Promise.all([
            pipeline.onUtterance('m1', utterance({ turnId: 1, text: 'alpha one' })),
            pipeline.onUtterance('m2', utterance({ turnId: 2, text: 'beta one' })),
        ]);
        await Promise.all([
            pipeline.onUtterance('m1', utterance({ turnId: 3, t0Ms: 3000, t1Ms: 4000, text: 'alpha two' })),
            pipeline.onUtterance('m2', utterance({ turnId: 4, t0Ms: 3000, t1Ms: 4000, text: 'beta two' })),
        ]);
        await Promise.all([pipeline.onSessionEnd('m1'), pipeline.onSessionEnd('m2')]);

        const textFor = (id) => store.chunks.filter((c) => c.meetingId === id && c.layer === 1)
            .map((c) => c.text).join(' ');

        expect(textFor('m1')).toContain('alpha');
        expect(textFor('m1')).not.toContain('beta');
        expect(textFor('m2')).toContain('beta');
        expect(textFor('m2')).not.toContain('alpha');
    });

    it('does not cross-contaminate the utterance log', async () => {
        await Promise.all([
            pipeline.onUtterance('m1', utterance({ turnId: 1, text: 'alpha' })),
            pipeline.onUtterance('m2', utterance({ turnId: 2, text: 'beta' })),
        ]);

        expect(store.utterances.find((u) => u.meetingId === 'm1').text).toBe('alpha');
        expect(store.utterances.find((u) => u.meetingId === 'm2').text).toBe('beta');
    });

    it('embeds each meeting against its own owner', async () => {
        require('../src/meetings/meeting.repository').getMeetingOwner
            .mockImplementation(async (id) => (id === 'm1' ? 'user-A' : 'user-B'));

        await Promise.all([
            pipeline.onUtterance('m1', utterance({ turnId: 1, text: 'alpha' })),
            pipeline.onUtterance('m2', utterance({ turnId: 2, text: 'beta' })),
        ]);
        await Promise.all([pipeline.onSessionEnd('m1'), pipeline.onSessionEnd('m2')]);

        const ownerOf = (id) => upserted.find((u) => u.payload.meetingId === id).payload.ownerId;
        expect(ownerOf('m1')).toBe('user-A');
        expect(ownerOf('m2')).toBe('user-B');
    });
});

describe('marking the meeting finished', () => {
    it('moves the meeting out of in-progress when the session ends', async () => {
        // every meeting has sat at in-progress forever, because nothing ever advanced it
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(completeMeeting).toHaveBeenCalledWith('m1');
    });

    it('does not fail the teardown when the status write fails', async () => {
        completeMeeting.mockRejectedValue(new Error('pg down'));

        await pipeline.onUtterance('m1', utterance());
        await expect(pipeline.onSessionEnd('m1')).resolves.toBeUndefined();
    });
});
