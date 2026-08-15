// Retrieval for meeting chat.
//
// Runs dense and sparse search per layer and fuses results by rank (RRF) instead of raw
// score, since cosine and BM25 scores aren't on comparable scales. Recent speech is pulled in
// as its own lane after fusion, since "what did they just say" is the most common live
// question and semantic search doesn't answer it well. A specific chunk wins over a summary
// covering the same span, so the model isn't stuck paraphrasing when the real words are there.
//
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
// How much of an abstract chunk a specific one must cover before it replaces it. Any overlap at
// all is too eager once layer 2 exists: a narrative spans several verbatim chunks, and one of
// them matching should not throw away the synthesis of the other seven.
const SUBSUME_COVERAGE = 0.6;

function coverageOf(inner, outer) {
    const span = outer.t1Ms - outer.t0Ms;
    if (span <= 0) return 0;
    const shared = Math.min(inner.t1Ms, outer.t1Ms) - Math.max(inner.t0Ms, outer.t0Ms);
    return Math.max(0, shared) / span;
}

// Chunks written by the current pipeline carry a token count; anything older, or a recent turn,
// does not. Four characters a token is close enough to size a context window against.
const sizeOf = (c) => c.tokens || Math.ceil((c.text || '').length / 4);

// Most of a layer's share of the context window, by layer.
//
// Narrative chunks were taking 68% of the budget on a 71-minute meeting, measured. They earn it
// on rank — a summary is written in the same register as a question, so it scores well against
// one — and then spend it on size, averaging 353 tokens against a verbatim chunk's 111. The
// effect grows with the meeting: at 18 minutes there are eight narratives and they cannot crowd
// anything out, at 71 minutes there are twenty-six and they alone are nearly twice the budget.
//
// That is the wrong way round. A summary is a paraphrase, and answering a specific question from
// a paraphrase is how a system ends up confidently vague, which matches what the long-meeting
// arm of the sweep actually looked like. Capping the abstract layers leaves room for the words
// that were really said; anything unspent still goes to the best remaining candidate.
const LAYER_CAPS = { 2: 0.35, 3: 0.25 };

/**
 * Fills the context up to a token budget rather than a fixed number of chunks.
 *
 * A fixed count gives a short meeting a quarter of itself as context and a long one a fourteenth,
 * while leaving most of the model's budget unspent either way. Candidates arrive best-first, and a
 * chunk that does not fit is skipped rather than ending the loop, since a smaller later one still
 * adds coverage. The top candidate is always returned even when it alone busts the budget —
 * sending a too-large prompt fails loudly, whereas returning nothing fails silently.
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

    // The top candidate always goes in, even when it alone busts the budget and whatever its
    // layer: sending a too-large prompt fails loudly, returning nothing fails silently.
    if (candidates.length) take(candidates[0]);

    // Two passes in rank order. The first honours each layer's ceiling; the second spends
    // whatever is left on the best remaining candidates regardless of layer, so a capped budget
    // is never handed back underfilled.
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
 * @param {function} [deps.embedQuery]    (text) => vector, so one question is embedded once
 *   rather than once per layer. Optional: without it each layer embeds for itself.
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

            // One embedding for the whole question, reused by every layer. Embedding per layer
            // tripled both the latency and the daily embedding quota a single question cost.
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

            // A lane that throws is tolerated — dense can carry sparse and vice versa — but the
            // count is kept, because every lane failing is a different situation from every lane
            // returning nothing, and the caller has to be able to tell them apart.
            let attempted = 0;
            let failed = 0;

            for (const layer of layers) {
                const args = { query, meetingId, ownerId, layer, limit: perLayer, vector };
                attempted += sparseSearch ? 2 : 1;

                // Invoked through Promise.resolve().then so a lane that throws synchronously
                // degrades like one that rejects, instead of taking the whole answer with it.
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
                    // Every search lane down is not the same as the meeting not mentioning it.
                    // Left undistinguished, a dead database reads to the user as a confident
                    // "that was never discussed" — which is worse than an error, because it
                    // sounds like an answer.
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
