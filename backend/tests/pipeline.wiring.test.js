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
    getUnembedded: jest.fn(async () => store.chunks.filter((c) => !c.vectorId)),
    getDirtyChunks: jest.fn(async () => store.chunks.filter((c) => c.dirty)),
    attachVector: jest.fn(async (meetingId, chunk, vectorId) => {
        const hit = store.chunks.find((c) => c.layer === chunk.layer && c.ordinal === chunk.ordinal);
        hit.vectorId = vectorId;
        hit.dirty = false;
        return hit;
    }),
}));

jest.mock('../src/transcript/utterance.repository', () => ({
    appendUtterance: jest.fn(async (meetingId, u) => { store.utterances.push({ meetingId, ...u }); }),
    reviseUtterance: jest.fn(async (meetingId, turnId, u) => { store.revisions.push({ meetingId, turnId, ...u }); }),
}));

jest.mock('../src/meetings/meeting.repository', () => ({
    getMeetingOwner: jest.fn(async () => 'user-A'),
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
}));

const pipeline = require('../src/transcript/pipeline.wiring');
const { insertChunk, markDirtyForRange, attachVector } = require('../src/transcript/chunk.repository');
const { appendUtterance, reviseUtterance } = require('../src/transcript/utterance.repository');
const { getEmbedding } = require('../src/providers/embedding/embedding.service');

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

        expect(store.chunks).toHaveLength(1);
        expect(store.chunks[0]).toMatchObject({ layer: 1, text: 'we should revisit pricing' });
    });

    it('embeds and indexes what it stored', async () => {
        await pipeline.onUtterance('m1', utterance({ speakerLabel: 'S1' }));
        await pipeline.onSessionEnd('m1');

        expect(upserted).toHaveLength(1);
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

        const embedded = getEmbedding.mock.calls.at(-1)[0];
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

        expect(store.chunks).toHaveLength(1);
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

    it('leaves a chunk unembedded when the provider is down, rather than marking it indexed', async () => {
        getEmbedding.mockRejectedValue(new Error('provider down'));

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(store.chunks[0].vectorId).toBeNull();
        expect(attachVector).not.toHaveBeenCalled();
    });

    it('picks up a chunk that failed an earlier pass', async () => {
        getEmbedding.mockRejectedValueOnce(new Error('transient'));

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(store.chunks[0].vectorId).not.toBeNull();
    });

    it('does not let an embedding failure escape into the meeting', async () => {
        getEmbedding.mockRejectedValue(new Error('provider down'));
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
