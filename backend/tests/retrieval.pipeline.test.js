jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const {
    createRetrieval, rrfFuse, dropSubsumed, overlapsInTime, takeWithinBudget,
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

// A dead search backend used to look exactly like a meeting that never mentioned the topic:
// empty context in, "the transcript does not cover that" out. That answer is worse than an
// error because it sounds correct.
describe('telling "found nothing" apart from "could not look"', () => {
    const boom = () => { throw new Error('ECONNREFUSED'); };

    it('reports unavailable when every lane fails', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(boom),
            sparseSearch: jest.fn(boom),
            recentTurns: jest.fn(boom),
        });
        const { stats } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1, 2],
        });

        expect(stats.unavailable).toBe(true);
        expect(stats.laneFailures).toBe(4);
    });

    it('does not report unavailable when the lanes simply found nothing', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(async () => []),
            sparseSearch: jest.fn(async () => []),
            recentTurns: jest.fn(async () => []),
        });
        const { context, stats } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1],
        });

        expect(context).toHaveLength(0);
        expect(stats.unavailable).toBe(false);
    });

    it('is not unavailable while one lane still answers', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(boom),
            sparseSearch: jest.fn(async () => [hit(1)]),
        });
        const { context, stats } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1],
        });

        expect(context).toHaveLength(1);
        expect(stats.unavailable).toBe(false);
    });

    // Search down but the recent window alive still gives the model something real to work from.
    it('is not unavailable when only the recent lane survives', async () => {
        const r = createRetrieval({
            denseSearch: jest.fn(boom),
            sparseSearch: jest.fn(boom),
            recentTurns: jest.fn(async () => [{ turnId: 't1', t0Ms: 0, t1Ms: 900, text: 'said' }]),
        });
        const { stats } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1],
        });

        expect(stats.unavailable).toBe(false);
    });
});

describe('one embedding per question', () => {
    it('embeds the question once and shares the vector across every layer', async () => {
        const embedQuery = jest.fn(async () => [0.1, 0.2]);
        const denseSearch = jest.fn(async () => []);
        const r = createRetrieval({ denseSearch, embedQuery });

        await r.retrieve({ query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1, 2, 3] });

        expect(embedQuery).toHaveBeenCalledTimes(1);
        expect(denseSearch).toHaveBeenCalledTimes(3);
        for (const call of denseSearch.mock.calls) {
            expect(call[0].vector).toEqual([0.1, 0.2]);
        }
    });

    // Losing the shared vector should cost a round-trip, not the answer.
    it('lets each layer embed for itself when the shared embedding fails', async () => {
        const denseSearch = jest.fn(async () => [hit(1)]);
        const r = createRetrieval({
            denseSearch,
            embedQuery: jest.fn(async () => { throw new Error('embedding 429'); }),
        });

        const { context } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1],
        });

        expect(denseSearch.mock.calls[0][0].vector).toBeNull();
        expect(context).toHaveLength(1);
    });

    it('still works with no embedQuery injected at all', async () => {
        const denseSearch = jest.fn(async () => [hit(1)]);
        const r = createRetrieval({ denseSearch });

        const { context } = await r.retrieve({
            query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1],
        });

        expect(context).toHaveLength(1);
    });
});

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

    // A fixed chunk count means coverage falls as meetings grow: 8 chunks is a quarter of an
    // 18-minute meeting and a fourteenth of a 71-minute one, while the prompt sits at well under
    // half the model's budget either way. Filling to the budget keeps coverage roughly flat.
    // Measured on a 71-minute meeting: narrative chunks took 68% of the window because they rank
    // well (written in the same register as the question) and cost 3x a verbatim chunk.
    describe('layer budget caps', () => {
        const at = (ordinal, layer, tokens) => hit(ordinal, { layer, tokens });

        it('stops summaries crowding out the words that were actually said', () => {
            // Every narrative outranks every verbatim chunk, which is the real failure.
            const candidates = [
                at(1, 2, 350), at(2, 2, 350), at(3, 2, 350), at(4, 2, 350),
                at(5, 1, 110), at(6, 1, 110), at(7, 1, 110), at(8, 1, 110),
            ];
            const kept = takeWithinBudget(candidates, 1000);

            const narrative = kept.filter((c) => c.layer === 2).reduce((n, c) => n + c.tokens, 0);
            expect(narrative).toBeLessThanOrEqual(350);      // 35% of 1000, so one chunk
            expect(kept.some((c) => c.layer === 1)).toBe(true);
        });

        it('spends leftover budget rather than returning it unused', () => {
            // Nothing but narratives available: the cap must not leave the window half empty.
            const candidates = [at(1, 2, 300), at(2, 2, 300), at(3, 2, 300)];
            const kept = takeWithinBudget(candidates, 1000);

            expect(kept).toHaveLength(3);
        });

        it('leaves verbatim uncapped', () => {
            const candidates = Array.from({ length: 10 }, (_, i) => at(i + 1, 1, 100));
            expect(takeWithinBudget(candidates, 1000)).toHaveLength(10);
        });

        it('still returns something when the best candidate alone busts the budget', () => {
            expect(takeWithinBudget([at(1, 2, 9000)], 1000)).toHaveLength(1);
        });

        it('keeps rank order within what it selects', () => {
            const candidates = [at(1, 1, 100), at(2, 2, 100), at(3, 1, 100)];
            expect(takeWithinBudget(candidates, 1000).map((c) => c.ordinal)).toEqual([1, 2, 3]);
        });
    });

    describe('token-budgeted context', () => {
        const sized = (ordinal, tokens) => hit(ordinal, { tokens });

        it('keeps taking candidates until the budget is spent', async () => {
            const r = createRetrieval({
                denseSearch: jest.fn(async () => [
                    sized(1, 300), sized(2, 300), sized(3, 300), sized(4, 300), sized(5, 300),
                ]),
            });
            const { context } = await r.retrieve({
                query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], maxContextTokens: 1000,
            });
            // 300 + 300 + 300 fits; the fourth would reach 1200.
            expect(context).toHaveLength(3);
        });

        it('overrides topN rather than being capped by it', async () => {
            const r = createRetrieval({
                denseSearch: jest.fn(async () => Array.from({ length: 30 }, (_, i) => sized(i + 1, 100))),
            });
            const { context } = await r.retrieve({
                query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1],
                topN: 8, maxContextTokens: 2000,
            });
            expect(context.length).toBeGreaterThan(8);
        });

        it('still returns the best candidate when it alone exceeds the budget', async () => {
            const r = createRetrieval({
                denseSearch: jest.fn(async () => [sized(1, 5000), sized(2, 100)]),
            });
            const { context } = await r.retrieve({
                query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], maxContextTokens: 1000,
            });
            expect(context).toHaveLength(1);
            expect(context[0].ordinal).toBe(1);
        });

        it('estimates a size for a candidate that carries no token count', async () => {
            const long = hit(1, { tokens: undefined, text: 'w '.repeat(2000) });
            const r = createRetrieval({
                denseSearch: jest.fn(async () => [long, sized(2, 50)]),
            });
            const { context } = await r.retrieve({
                query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], maxContextTokens: 400,
            });
            expect(context).toHaveLength(1);
        });

        it('falls back to topN when no budget is given', async () => {
            const r = createRetrieval({
                denseSearch: jest.fn(async () => Array.from({ length: 20 }, (_, i) => sized(i + 1, 10))),
            });
            const { context } = await r.retrieve({
                query: 'q', meetingId: 'm1', ownerId: 'u', layers: [1], topN: 8,
            });
            expect(context).toHaveLength(8);
        });
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
