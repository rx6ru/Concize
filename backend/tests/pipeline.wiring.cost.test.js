// Proves the narration lane (pipeline.wiring.js's narrator) is gated by the cost breaker, not
// only counted by it, and that the gate is checked before the completion call, not after: a
// ceiling already crossed must stop the call from happening at all.
//
// Real cost.breaker and a real, temp-file-backed usage.ledger — a mocked breaker would hide
// exactly the wiring gap this proves is closed.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-ledger-'));
process.env.USAGE_LEDGER_DIR = tmpDir;
const ledgerFile = path.join(tmpDir, 'concize-usage.jsonl');

// Real config (as pipeline.wiring.test.js also uses), not a stub: pipeline.wiring.js pulls in
// enough of the provider stack transitively (reconcile.wiring -> sarvam.batch -> sarvam.js reads
// config.inference.sarvamKeys, for one) that a partial config mock breaks module loading rather
// than the narrator specifically. The override env var is what a real operator would set too.
process.env.COST_CEILING_TOKENS_PER_DAY = '100';

const store = { chunks: [] };

jest.mock('../src/transcript/chunk.repository', () => ({
    insertChunk: jest.fn(async (meetingId, chunk) => {
        const stored = { meetingId, rev: 0, vectorId: null, dirty: false, ...chunk };
        store.chunks.push(stored);
        return stored;
    }),
    markDirtyForRange: jest.fn(async () => {}),
    getUnembedded: jest.fn(async () => []),
    getDirtyChunks: jest.fn(async () => []),
    attachVector: jest.fn(async () => {}),
    nextOrdinal: jest.fn(async () => 0),
}));

jest.mock('../src/transcript/utterance.repository', () => ({
    appendUtterance: jest.fn(async () => {}),
    reviseUtterance: jest.fn(async () => {}),
}));

jest.mock('../src/meetings/meeting.service', () => ({
    completeMeeting: jest.fn(async () => true),
}));

jest.mock('../src/meetings/meeting.repository', () => ({
    getMeetingOwner: jest.fn(async () => 'user-A'),
    appendTranscription: jest.fn(async () => ({ success: true, chunkIndex: 0 })),
}));

jest.mock('../src/infra/queue', () => ({ publishToQueue: jest.fn(async () => {}) }));

const mockCreate = jest.fn(async () => ({
    choices: [{ message: { content: 'narrated text' } }],
    usage: { total_tokens: 10 },
}));

jest.mock('../src/providers/llm/inference.provider', () => ({
    getSummaryInference: () => ({
        client: { chat: { completions: { create: mockCreate } } },
        model: 'narration-model',
        taskConfig: { provider: 'test-provider', model: 'narration-model' },
    }),
}));

jest.mock('../src/summary/summary.repository', () => ({
    getMeetingSummary: jest.fn(async () => null),
}));

jest.mock('../src/infra/qdrant', () => ({
    getQdrant: () => ({
        getCollections: jest.fn(async () => ({ collections: [] })),
        createCollection: jest.fn(async () => {}),
        createPayloadIndex: jest.fn(async () => {}),
        upsert: jest.fn(async () => {}),
    }),
}));

jest.mock('../src/providers/embedding/embedding.service', () => ({
    getEmbedding: jest.fn(async () => new Array(768).fill(0.1)),
    getEmbeddingWithRetry: jest.fn(async () => new Array(768).fill(0.1)),
}));

jest.mock('../src/providers/embedding/embedding.batch', () => ({
    getEmbeddings: jest.fn(async (texts) => texts.map(() => new Array(768).fill(0.1))),
}));

// Not mocked: the real cost.breaker and the real usage.ledger (pointed at tmpDir above).
const { ledger } = require('../src/core/usage.ledger');
const pipeline = require('../src/transcript/pipeline.wiring');

const utterance = (over = {}) => ({
    turnId: 1, t0Ms: 0, t1Ms: 2000, text: 'we should revisit pricing', ...over,
});

beforeEach(() => {
    store.chunks.length = 0;
    mockCreate.mockClear();
    fs.rmSync(ledgerFile, { force: true });
    pipeline._resetForTests();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('narration cost gating', () => {
    it('refuses to call the provider once the ceiling is already crossed', async () => {
        ledger.record('test-provider', 'narration-model', 150); // over the 100-token ceiling

        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(mockCreate).not.toHaveBeenCalled();
        expect(store.chunks.some((c) => c.layer === 2)).toBe(false);
    });

    it('narrates normally under the ceiling, and records what it spent', async () => {
        await pipeline.onUtterance('m1', utterance());
        await pipeline.onSessionEnd('m1');

        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(store.chunks.some((c) => c.layer === 2)).toBe(true);
        expect(ledger.spentToday('test-provider', 'narration-model')).toBe(10);
    });
});
