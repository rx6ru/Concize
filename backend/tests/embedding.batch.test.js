jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/core/config', () => ({
    inference: { geminiKeys: ['key-a', 'key-b'] },
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

const gemini = require('../src/providers/llm/gemini');

// The rotator is a process-wide singleton, and a 429 in one test rests a key for a real minute.
// Left alone, that leaks into whichever test runs next and makes rotation look broken.
beforeEach(() => {
    global.fetch = okFetch(2);
    ledger.record.mockClear();
    gemini.dead.clear();
    gemini.restingUntil.clear();
    gemini.currentIndex = 0;
});

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
    // The batch path pinned geminiKeys[0], so one key's daily quota ran out while the rest of the
    // pool sat untouched. Two batches, two keys.
    it('spreads batches across the key pool instead of pinning the first key', async () => {
        const texts = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `chunk ${i}`);
        const used = [];
        global.fetch = jest.fn(async (url, opts) => {
            used.push(new URL(url).searchParams.get('key'));
            const n = JSON.parse(opts.body).requests.length;
            return { ok: true, status: 200, json: async () => vectors(n) };
        });

        await getEmbeddings(texts);

        expect(used).toHaveLength(2);
        expect(new Set(used).size).toBe(2);
    });

    // withRetry re-invokes the same closure, so a key drawn outside it is retried against itself
    // while the rest of the pool sits idle. One batch of <=50 chunks is the common case, and it
    // never reaches the between-batch rotation above.
    it('draws a fresh key on each retry, not the one that just failed', async () => {
        // Stands in for withRetry: one retry, same closure, exactly how runResilient calls it.
        runResilient.mockImplementationOnce(async (provider, fn) => {
            try { return await fn(); } catch { return await fn(); }
        });
        const used = [];
        global.fetch = jest.fn(async (url) => {
            const key = new URL(url).searchParams.get('key');
            used.push(key);
            if (used.length === 1) {
                return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
            }
            return { ok: true, status: 200, json: async () => vectors(2) };
        });

        await getEmbeddings(['a', 'b']);

        expect(used).toHaveLength(2);
        expect(used[1]).not.toBe(used[0]);
    });

    // A key that answered 429 is spent, not broken: resting it keeps the next batch off it.
    it('rests a key the provider rate limited', async () => {
        const spent = [];
        jest.spyOn(gemini, 'reportFailure').mockImplementation((key, status) => spent.push([key, status]));
        global.fetch = jest.fn(async () => ({
            ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }),
        }));

        await expect(getEmbeddings(['a', 'b'])).rejects.toThrow(/429/);

        expect(spent).toHaveLength(1);
        expect(spent[0][1]).toBe(429);
        gemini.reportFailure.mockRestore();
    });

    // A caller that brought its own key is not drawing on the pool, so a failure there says
    // nothing about pool health and must not rest a key that is fine.
    it('leaves the pool alone when the caller supplies its own key', async () => {
        jest.spyOn(gemini, 'reportFailure');
        global.fetch = jest.fn(async () => ({
            ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }),
        }));

        await expect(getEmbeddings(['a'], { apiKey: 'caller-key' })).rejects.toThrow(/429/);

        expect(gemini.reportFailure).not.toHaveBeenCalled();
        gemini.reportFailure.mockRestore();
    });
});
