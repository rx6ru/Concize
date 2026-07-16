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
 * @param {function} deps.denseSearch     ({query, meetingId, ownerId, layer, limit}) => hits
 * @param {function} [deps.sparseSearch]  same shape; omit to run dense-only
 * @param {function} [deps.recentTurns]   ({meetingId, sinceMs}) => utterances
 * @param {function} [deps.rerank]        ({query, candidates, topN}) => candidates
 */
function createRetrieval({ denseSearch, sparseSearch = null, recentTurns = null, rerank = null }) {

    const keyOf = (c) => c.vectorId || `${c.layer}:${c.ordinal}:${c.rev ?? 0}`;

    return {
        /**
         * @param {object} opts
         * @param {string} opts.query
         * @param {string} opts.meetingId
         * @param {string} opts.ownerId
         * @param {number[]} [opts.layers]
         * @param {number} [opts.perLayer]      candidates fetched per layer per engine
         * @param {number} [opts.topN]          final context size
         * @param {number} [opts.recentMs]      size of the always-included recent window
         * @param {number} [opts.watermarkMs]   how far the indexed transcript reaches
         */
        async retrieve({
            query, meetingId, ownerId,
            layers = [1, 2, 3], perLayer = 20, topN = 8,
            recentMs = 60000, watermarkMs = null,
        }) {
            const lists = [];

            for (const layer of layers) {
                const args = { query, meetingId, ownerId, layer, limit: perLayer };
                const [dense, sparse] = await Promise.all([
                    denseSearch(args).catch((err) => {
                        logger.error('Dense search failed', { meetingId, layer, error: err.message });
                        return [];
                    }),
                    sparseSearch
                        ? sparseSearch(args).catch((err) => {
                            logger.error('Sparse search failed', { meetingId, layer, error: err.message });
                            return [];
                        })
                        : Promise.resolve(null),
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

            candidates = dropSubsumed(candidates).slice(0, topN);

            // Recent turns skip ranking and fusion entirely and are never trimmed off.
            let recent = [];
            if (recentTurns) {
                try {
                    recent = await recentTurns({ meetingId, sinceMs: recentMs }) || [];
                } catch (err) {
                    logger.error('Recent turns failed', { meetingId, error: err.message });
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
                },
                freshness: watermarkMs == null ? null : { watermarkMs },
            };
        },
    };
}

module.exports = { createRetrieval, rrfFuse, dropSubsumed, overlapsInTime, RRF_K };
