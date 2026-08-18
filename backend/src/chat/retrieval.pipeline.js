// Retrieval for meeting chat: dense and sparse search per layer, fused by RRF (rank, not raw score) since cosine and BM25 aren't comparable.
// Recent speech is pulled in as its own lane after fusion, since "what did they just say" is common and semantic search answers it poorly.
// Everything external is injected, so this is testable without a vector database.

'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('retrieval');

const RRF_K = 60;   // standard damping; large enough that rank 1 does not dominate outright

/**
 * Reciprocal-rank fusion over any number of ranked lists.
 * @param {Array<Array<object>>} lists  each ordered best-first
 * @param {function} keyOf              stable identity for a candidate
 */
function rrfFuse(lists, keyOf, k = RRF_K) {
    const scores = new Map();

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        list.forEach((item, index) => {
            const key = keyOf(item);
            const entry = scores.get(key) || { item, score: 0, lanes: 0 };
            entry.score += 1 / (k + index + 1);
            entry.lanes += 1;
            // Prefer the richer copy if lanes return partial payloads.
            if (Object.keys(item).length > Object.keys(entry.item).length) entry.item = item;
            scores.set(key, entry);
        });
    }

    return [...scores.values()]
        .sort((a, b) => b.score - a.score)
        .map(({ item, score, lanes }) => ({ ...item, _rrf: score, _lanes: lanes }));
}

const overlapsInTime = (a, b) => a.t0Ms < b.t1Ms && b.t0Ms < a.t1Ms;

/**
 * Drops abstract candidates already covered by a more specific one.
 * Lower layer number = more specific (1 verbatim, 2 narrative, 3 topic).
 */
// Coverage needed before a specific chunk replaces an abstract one. Any overlap is too eager: a narrative spans several verbatim chunks, and one matching shouldn't discard the synthesis of the rest.
const SUBSUME_COVERAGE = 0.6;

function coverageOf(inner, outer) {
    const span = outer.t1Ms - outer.t0Ms;
    if (span <= 0) return 0;
    const shared = Math.min(inner.t1Ms, outer.t1Ms) - Math.max(inner.t0Ms, outer.t0Ms);
    return Math.max(0, shared) / span;
}

// Chunks from the current pipeline carry a token count; older chunks and recent turns don't, so fall back to length/4 as a token estimate.
const sizeOf = (c) => c.tokens || Math.ceil((c.text || '').length / 4);

// Cap on each layer's share of the context budget: narratives took 68% of it on a 71-minute meeting (measured), by ranking well but averaging 353 tokens against a verbatim chunk's 111.
// Answering a specific question from a paraphrase reads as confidently vague; capping the abstract layers leaves room for the actual words, and unspent budget still goes to the best remaining candidate.
const LAYER_CAPS = { 2: 0.35, 3: 0.25 };

/**
 * Fills the context up to a token budget rather than a fixed chunk count.
 * A fixed count gives a short meeting a quarter of itself as context and a long one a fourteenth, leaving most of the budget unspent either way.
 */
function takeWithinBudget(candidates, budget, { layerCaps = LAYER_CAPS } = {}) {
    const taken = new Set();
    const spentByLayer = new Map();
    let spent = 0;

    const take = (c) => {
        const size = sizeOf(c);
        taken.add(c);
        spent += size;
        spentByLayer.set(c.layer, (spentByLayer.get(c.layer) || 0) + size);
    };

    // Top candidate always goes in, even if it alone busts the budget: a too-large prompt fails loudly, an empty one fails silently.
    if (candidates.length) take(candidates[0]);

    // Two passes in rank order: first honors each layer's cap, second spends what's left regardless of layer so a capped budget isn't handed back underfilled.
    for (const useCaps of [true, false]) {
        for (const c of candidates) {
            if (taken.has(c)) continue;
            const size = sizeOf(c);
            if (spent + size > budget) continue;

            const cap = useCaps ? layerCaps[c.layer] : null;
            if (cap != null && (spentByLayer.get(c.layer) || 0) + size > budget * cap) continue;

            take(c);
        }
    }

    // Rank order, so the second pass cannot shuffle a later candidate ahead of an earlier one.
    return candidates.filter((c) => taken.has(c));
}

function dropSubsumed(candidates) {
    const kept = [];
    for (const c of candidates) {
        const subsumed = kept.some((k) => k.layer < c.layer && coverageOf(k, c) >= SUBSUME_COVERAGE);
        if (!subsumed) kept.push(c);
    }
    return kept;
}

/**
 * @param {object} deps
 * @param {function} deps.denseSearch     ({query, meetingId, ownerId, layer, limit, vector}) => hits
 * @param {function} [deps.sparseSearch]  same shape; omit to run dense-only
 * @param {function} [deps.recentTurns]   ({meetingId, sinceMs}) => utterances
 * @param {function} [deps.rerank]        ({query, candidates, topN}) => candidates
 * @param {function} [deps.embedQuery]    (text) => vector; embeds once per question instead of once per layer. Optional.
 */
function createRetrieval({
    denseSearch, sparseSearch = null, recentTurns = null, rerank = null, embedQuery = null,
}) {

    const keyOf = (c) => c.vectorId || `${c.layer}:${c.ordinal}:${c.rev ?? 0}`;

    return {
        /**
         * @param {object} opts
         * @param {string} opts.query
         * @param {string} opts.meetingId
         * @param {string} opts.ownerId
         * @param {number[]} [opts.layers]
         * @param {number} [opts.perLayer]      candidates fetched per layer per engine
         * @param {number} [opts.topN]          final context size, when no token budget is given
         * @param {number} [opts.maxContextTokens] fill to this many tokens instead of topN chunks
         * @param {number} [opts.recentMs]      size of the always-included recent window
         * @param {number} [opts.watermarkMs]   how far the indexed transcript reaches
         */
        async retrieve({
            query, meetingId, ownerId,
            layers = [1, 2, 3], perLayer = 20, topN = 8, maxContextTokens = null,
            recentMs = 60000, watermarkMs = null,
        }) {
            const lists = [];

            // One embedding per question, reused across layers: per-layer embedding tripled both latency and the daily embedding quota per question.
            let vector = null;
            if (embedQuery) {
                try {
                    vector = await embedQuery(query);
                } catch (err) {
                    // Let each layer try for itself rather than lose the answer outright.
                    logger.warn('Query embedding failed, falling back to per-layer',
                        { meetingId, error: err.message });
                }
            }

            // A lane throwing is tolerated (dense can carry sparse and vice versa), but the failure count is kept so the caller can tell "every lane failed" apart from "every lane returned nothing".
            let attempted = 0;
            let failed = 0;

            for (const layer of layers) {
                const args = { query, meetingId, ownerId, layer, limit: perLayer, vector };
                attempted += sparseSearch ? 2 : 1;

                // Wrapped in Promise.resolve().then so a synchronous throw degrades like a rejection instead of taking the whole answer down.
                const run = (fn, name) => Promise.resolve()
                    .then(() => fn(args))
                    .catch((err) => {
                        logger.error(`${name} search failed`, { meetingId, layer, error: err.message });
                        failed += 1;
                        return [];
                    });

                const [dense, sparse] = await Promise.all([
                    run(denseSearch, 'Dense'),
                    sparseSearch ? run(sparseSearch, 'Sparse') : Promise.resolve(null),
                ]);
                lists.push(dense);
                if (sparse) lists.push(sparse);
            }

            let candidates = rrfFuse(lists, keyOf);

            if (rerank && candidates.length) {
                try {
                    candidates = await rerank({ query, candidates, topN: topN * 3 });
                } catch (err) {
                    // Reranking is a precision improvement, not a correctness requirement.
                    logger.error('Rerank failed, falling back to fusion order',
                        { meetingId, error: err.message });
                }
            }

            candidates = dropSubsumed(candidates);
            candidates = maxContextTokens
                ? takeWithinBudget(candidates, maxContextTokens)
                : candidates.slice(0, topN);

            // Recent turns skip ranking and fusion entirely and are never trimmed off.
            let recent = [];
            let recentFailed = false;
            if (recentTurns) {
                try {
                    recent = await Promise.resolve()
                        .then(() => recentTurns({ meetingId, sinceMs: recentMs })) || [];
                } catch (err) {
                    logger.error('Recent turns failed', { meetingId, error: err.message });
                    recentFailed = true;
                }
            }

            const context = [
                ...candidates.map((c) => ({ ...c, source: 'retrieved' })),
                ...recent.map((u) => ({ ...u, source: 'recent', layer: 0 })),
            ];

            // Chronological: an LLM reasons far better over a meeting in the order it happened.
            const deduped = [];
            const seen = new Set();
            for (const item of context.sort((a, b) => a.t0Ms - b.t0Ms)) {
                const key = item.turnId ? `turn:${item.turnId}` : keyOf(item);
                if (seen.has(key)) continue;
                seen.add(key);
                deduped.push(item);
            }

            return {
                context: deduped,
                stats: {
                    retrieved: candidates.length,
                    recent: recent.length,
                    hasOverlap: deduped.some((c) => c.hasOverlap),
                    unattributed: deduped.some((c) => !c.speakerLabel && !(c.speakers || []).length),
                    // Every lane failing is not the same as the meeting not mentioning it: left undistinguished, a dead database reads as a confident "that was never discussed", which is worse than an error since it sounds like an answer.
                    unavailable: attempted > 0 && failed === attempted
                        && (!recentTurns || recentFailed),
                    laneFailures: failed,
                },
                freshness: watermarkMs == null ? null : { watermarkMs },
            };
        },
    };
}

module.exports = {
    createRetrieval, rrfFuse, dropSubsumed, overlapsInTime, takeWithinBudget, RRF_K, LAYER_CAPS,
};
