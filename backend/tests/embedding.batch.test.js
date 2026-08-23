jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/core/config', () => ({
    inference: { geminiKeys: ['test-key'] },
}));

jest.mock('../src/core/usage.ledger', () => ({ ledger: { record: jest.fn() } }));

// Pass-through by default; one test asserts the call actually goes through it.
jest.mock('../src/providers/llm/resilient.inference', () => ({
    runResilient: jest.fn((provider, fn) => fn()),
}));

const { runResilient } = require('../src/providers/llm/resilient.inference');
const { ledger } = require('../src/core/usage.ledger');

const { getEmbeddings, BATCH_SIZE } = require('../src/providers/embedding/embedding.batch');

const vectors = (n) => ({ embeddings: Array.from({ length: n }, () => ({ values: new Array(768).fill(0.1) })) });

const okFetch = (n) => jest.fn(async () => ({
    ok: true, status: 200, json: async () => vectors(n),
}));

beforeEach(() => { global.fetch = okFetch(2); ledger.record.mockClear(); });

describe('batch embedding', () => {
    // One request per chunk is what put a 116-chunk meeting past the provider's 100-per-minute
    // ceiling. The same meeting is two requests when they go together.
    it('embeds many texts in a single request', async () => {
        const out = await getEmbeddings(['a', 'b']);

        expect(out).toHaveLength(2);
        expect(out[0]).toHaveLength(768);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('splits past the provider\'s per-request cap', async () => {
        const texts = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `chunk ${i}`);
        global.fetch = jest.fn(async (url, opts) => {
            const n = JSON.parse(opts.body).requests.length;
            return { ok: true, status: 200, json: async () => vectors(n) };
        });

        const out = await getEmbeddings(texts);

        expect(out).toHaveLength(BATCH_SIZE + 5);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps vectors aligned with the texts that produced them', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ embeddings: [{ values: [1] }, { values: [2] }, { values: [3] }] }),
        }));

        expect(await getEmbeddings(['a', 'b', 'c'])).toEqual([[1], [2], [3]]);
    });

    it('returns nothing for no input without calling out', async () => {
        expect(await getEmbeddings([])).toEqual([]);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    // A short response would silently shift every vector onto the wrong chunk, which is worse
    // than failing: the index would look full and be wrong.
    it('refuses a response with the wrong number of vectors', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true, status: 200, json: async () => ({ embeddings: [{ values: [1] }] }),
        }));

        await expect(getEmbeddings(['a', 'b'])).rejects.toThrow(/expected 2/i);
    });

    // The single-text path went through the resilient wrapper (per-model spacing, jittered retry,
    // breaker). Batching must not quietly drop that, or one 429 loses a whole pass instead of one
    // chunk — which is a strictly worse failure than the one it replaced.
    it('goes through the rate limiter and retry, naming the model so spacing applies', async () => {
        await getEmbeddings(['a', 'b']);

        expect(runResilient).toHaveBeenCalledWith(
            'gemini', expect.any(Function), expect.objectContaining({ model: 'gemini-embedding-001' })
        );
    });

    it('surfaces a provider error rather than returning empty vectors', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }),
        }));

        await expect(getEmbeddings(['a', 'b'])).rejects.toThrow(/429/);
    });

    // batchEmbedContents returns no usageMetadata, so this is the one point where a real count
    // (however estimated) can be attached to what actually got billed on the real, paid tier.
    it('records an estimated token count for what it actually sent, not zero', async () => {
        await getEmbeddings(['one two three', 'four five']);

        expect(ledger.record).toHaveBeenCalledWith('gemini', 'gemini-embedding-001', expect.any(Number));
        const [, , tokens] = ledger.record.mock.calls[0];
        expect(tokens).toBeGreaterThan(0);
    });

    it('still records once per batch request, the unit the free-tier quota actually caps', async () => {
        const texts = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `chunk ${i}`);
        global.fetch = jest.fn(async (url, opts) => {
            const n = JSON.parse(opts.body).requests.length;
            return { ok: true, status: 200, json: async () => vectors(n) };
        });

        await getEmbeddings(texts);

        expect(ledger.record).toHaveBeenCalledTimes(2);
    });
});
