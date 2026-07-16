jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const {
    createRetrieval, rrfFuse, dropSubsumed, overlapsInTime,
} = require('../src/chat/retrieval.pipeline');

const hit = (ordinal, over = {}) => ({
    vectorId: `v${ordinal}`, layer: 1, ordinal, rev: 0,
    t0Ms: ordinal * 1000, t1Ms: ordinal * 1000 + 900,
    text: `chunk ${ordinal}`, speakers: ['S1'], hasOverlap: false, ...over,
});
const keyOf = (c) => c.vectorId;

describe('reciprocal rank fusion', () => {
    it('ranks an item found by both engines above one found by either alone', () => {
        const dense = [hit(1), hit(2)];
        const sparse = [hit(3), hit(1)];
        const fused = rrfFuse([dense, sparse], keyOf);

        expect(fused[0].ordinal).toBe(1);
        expect(fused[0]._lanes).toBe(2);
    });

    it('fuses on rank, not score — a huge score cannot buy a low rank', () => {
        const dense = [{ ...hit(1), score: 0.99 }, { ...hit(2), score: 0.01 }];
        const sparse = [{ ...hit(2), score: 900 }, { ...hit(1), score: 1 }];
        const fused = rrfFuse([dense, sparse], keyOf);

        // symmetric ranks, so the raw magnitudes must not decide it
        expect(fused[0]._rrf).toBeCloseTo(fused[1]._rrf, 10);
    });

    it('ignores missing or empty lists', () => {
        expect(rrfFuse([null, [], [hit(1)]], keyOf)).toHaveLength(1);
    });

    it('keeps the richer payload when lanes disagree', () => {
        const thin = [{ vectorId: 'v1', layer: 1, ordinal: 1, t0Ms: 0, t1Ms: 1 }];
        const rich = [hit(1, { text: 'full text' })];
        expect(rrfFuse([thin, rich], keyOf)[0].text).toBe('full text');
    });

    it('returns an empty list for no input', () => {
        expect(rrfFuse([], keyOf)).toEqual([]);
    });
});

describe('specificity', () => {
    it('detects time overlap', () => {
        expect(overlapsInTime({ t0Ms: 0, t1Ms: 100 }, { t0Ms: 50, t1Ms: 150 })).toBe(true);
        expect(overlapsInTime({ t0Ms: 0, t1Ms: 100 }, { t0Ms: 100, t1Ms: 200 })).toBe(false);
    });

    it('drops a topic chunk the verbatim one mostly covers', () => {
        const kept = dropSubsumed([
            hit(1, { layer: 1, t0Ms: 0, t1Ms: 85000 }),
            hit(2, { layer: 3, t0Ms: 0, t1Ms: 90000 }),
        ]);
        expect(kept).toHaveLength(1);
        expect(kept[0].layer).toBe(1);
    });

    it('keeps a topic chunk a short verbatim one barely touches', () => {
        const kept = dropSubsumed([
            hit(1, { layer: 1, t0Ms: 0, t1Ms: 5000 }),
            hit(2, { layer: 3, t0Ms: 0, t1Ms: 90000 }),
        ]);
        expect(kept).toHaveLength(2);
    });

    it('keeps a narrative when only a small part of it also matched', () => {
        // a layer-2 chunk spans several layer-1 ones; one of them matching should not
        // throw away the synthesis of the rest
        const kept = dropSubsumed([
            hit(1, { layer: 1, t0Ms: 60000, t1Ms: 90000 }),
            hit(2, { layer: 2, t0Ms: 0, t1Ms: 300000 }),
        ]);
        expect(kept).toHaveLength(2);
    });

    it('keeps an abstract chunk covering a different span', () => {
        const kept = dropSubsumed([
            hit(1, { layer: 1, t0Ms: 0, t1Ms: 5000 }),
            hit(2, { layer: 3, t0Ms: 60000, t1Ms: 90000 }),
        ]);
        expect(kept).toHaveLength(2);
    });

    it('does not drop a specific chunk because an abstract one ranked higher', () => {
        const kept = dropSubsumed([
            hit(2, { layer: 3, t0Ms: 0, t1Ms: 90000 }),
            hit(1, { layer: 1, t0Ms: 0, t1Ms: 5000 }),
        ]);
        expect(kept.map((c) => c.layer)).toEqual([3, 1]);
    });
});

function makeRetrieval(over = {}) {
    return createRetrieval({
        denseSearch: jest.fn(async ({ layer }) => (layer === 1 ? [hit(1), hit(2)] : [])),
        ...over,
    });
}

describe('retrieve', () => {
    it('runs dense and sparse per layer and fuses them', async () => {
        const denseSearch = jest.fn(async () => [hit(1)]);
        const sparseSearch = jest.fn(async () => [hit(2)]);
        const r = createRetrieval({ denseSearch, sparseSearch });

        const { context } = await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });

        expect(denseSearch).toHaveBeenCalledTimes(1);
        expect(sparseSearch).toHaveBeenCalledTimes(1);
        expect(context).toHaveLength(2);
    });

    it('survives a dense search failure without losing the sparse results', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => { throw new Error('qdrant down'); }),
            sparseSearch: jest.fn(async () => [hit(2)]),
        });
        const { context } = await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });
        expect(context).toHaveLength(1);
    });

    it('always includes recent speech, even when it did not rank', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => [hit(1)]),
            recentTurns: jest.fn(async () => [
                { turnId: 't99', t0Ms: 500000, t1Ms: 501000, text: 'just said this', speakerLabel: 'S2' },
            ]),
        });
        const { context, stats } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], topN: 1,
        });

        expect(stats.recent).toBe(1);
        expect(context.some((c) => c.source === 'recent' && c.text === 'just said this')).toBe(true);
    });

    it('does not let topN trim away the recent lane', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => [hit(1), hit(2), hit(3)]),
            recentTurns: jest.fn(async () => [{ turnId: 't99', t0Ms: 900000, t1Ms: 901000, text: 'newest' }]),
        });
        const { context } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], topN: 1,
        });
        expect(context.filter((c) => c.source === 'recent')).toHaveLength(1);
    });

    it('returns context in chronological order', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => [hit(5), hit(1), hit(3)]),
        });
        const { context } = await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });
        expect(context.map((c) => c.t0Ms)).toEqual([1000, 3000, 5000]);
    });

    it('does not duplicate a turn present in both lanes', async () => {
        const shared = { turnId: 't7', t0Ms: 1000, t1Ms: 2000, text: 'shared', layer: 1, vectorId: 'vX' };
        const r = createRetrieval({
            denseSearch: jest.fn(async () => [shared]),
            recentTurns: jest.fn(async () => [shared]),
        });
        const { context } = await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });
        expect(context).toHaveLength(1);
    });

    it('applies the reranker when supplied', async () => {
        const rerank = jest.fn(async ({ candidates }) => [...candidates].reverse());
        const r = createRetrieval({ denseSearch: jest.fn(async () => [hit(1), hit(2)]), rerank });

        await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });
        expect(rerank).toHaveBeenCalled();
    });

    it('falls back to fusion order when the reranker fails', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => [hit(1), hit(2)]),
            rerank: jest.fn(async () => { throw new Error('cohere down'); }),
        });
        const { context } = await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });
        expect(context).toHaveLength(2);
    });

    it('flags overlapped and unattributed context so the prompt can hedge', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => [hit(1, { hasOverlap: true, speakers: [] })]),
        });
        const { stats } = await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1] });
        expect(stats).toMatchObject({ hasOverlap: true, unattributed: true });
    });

    it('reports freshness when a watermark is supplied', async () => {
        const r = makeRetrieval();
        const { freshness } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], watermarkMs: 42000,
        });
        expect(freshness).toEqual({ watermarkMs: 42000 });
    });

    it('searches every requested layer', async () => {
        const denseSearch = jest.fn(async () => []);
        const r = createRetrieval({ denseSearch });
        await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1, 2, 3] });

        expect(denseSearch.mock.calls.map((c) => c[0].layer)).toEqual([1, 2, 3]);
    });

    it('passes ownerId to the search layer for tenant isolation', async () => {
        const denseSearch = jest.fn(async () => []);
        const r = createRetrieval({ denseSearch });
        await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'user-A', layers: [1] });

        expect(denseSearch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'user-A' }));
    });
});
