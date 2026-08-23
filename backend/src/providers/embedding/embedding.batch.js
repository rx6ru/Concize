// Embeds many texts in one request.
// The single-text path costs one request per chunk against a 100/minute cap (core/provider.limits.json), a 116-chunk meeting exceeded its own minute's budget in one indexing pass. Batched, the same meeting is two requests.
// Uses the REST endpoint directly: the @google/genai SDK's `embedContent` only takes one text at a time.

'use strict';

const config = require('../../core/config');
const { runResilient } = require('../llm/resilient.inference');
const { ledger } = require('../../core/usage.ledger');
const { createLogger } = require('../../core/logger');

const logger = createLogger('embeddingBatch');

const MODEL_ID = 'gemini-embedding-001';
const DEFAULT_OUTPUT_DIMENSIONALITY = 768;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// The provider caps a batch at 100. Kept below that so a single oversized chunk cannot push the request past its token limit and take the whole batch down with it.
const BATCH_SIZE = 50;

const chunked = (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

// batchEmbedContents' response carries no usageMetadata (unlike generateContent), so there is no real token count to read off it.
// Same rough estimate chunk.boundary.js's estimateTokens uses for chunking (~1.3 tokens/word, not a real tokenizer call), rather than inventing a second heuristic.
const estimateTokens = (text) => (text ? Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3) : 0);

async function embedBatch(texts, { model, outputDimensionality, apiKey }) {
    const res = await fetch(`${ENDPOINT}/${model}:batchEmbedContents?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: texts.map((text) => ({
                model: `models/${model}`,
                content: { parts: [{ text }] },
                outputDimensionality,
            })),
        }),
    });

    const json = await res.json();
    if (!res.ok) {
        throw new Error(`embedding batch failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    }

    const vectors = (json.embeddings || []).map((e) => e.values);
    // Results are positional. A short response would shift every vector onto the wrong chunk and leave an index that looks complete and is silently wrong, so this is fatal rather than partial.
    if (vectors.length !== texts.length) {
        throw new Error(`embedding batch returned ${vectors.length} vectors, expected ${texts.length}`);
    }
    return vectors;
}

/** Vectors for many texts, in the same order as the input. */
async function getEmbeddings(texts, opts = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = opts.apiKey || (config.inference.geminiKeys || [])[0];
    if (!apiKey) throw new Error('no Gemini API key configured');

    const model = opts.model || MODEL_ID;
    const outputDimensionality = opts.outputDimensionality ?? DEFAULT_OUTPUT_DIMENSIONALITY;

    // Through the resilient wrapper, exactly as the single-text path was: per-model request spacing from provider.limits.json, jittered retry, breaker. Batching makes each failure more expensive, a 429 now costs a whole pass rather than one chunk, so this matters more here, not less.
    const out = [];
    for (const batch of chunked(texts, BATCH_SIZE)) {
        const vectors = await runResilient(
            'gemini',
            () => embedBatch(batch, { model, outputDimensionality, apiKey }),
            { model, maxRetries: 3, baseDelayMs: 1000, capDelayMs: 20000 }
        );
        out.push(...vectors);
        // The free-tier quota is metered per request (provider.limits.json), but real billing on this model is per token, so an estimated token count is recorded alongside the request either way.
        const tokens = batch.reduce((sum, text) => sum + estimateTokens(text), 0);
        ledger.record('gemini', model, tokens);
    }

    logger.debug('Batch embedding complete', { texts: texts.length, requests: Math.ceil(texts.length / BATCH_SIZE) });
    return out;
}

module.exports = { getEmbeddings, BATCH_SIZE };
