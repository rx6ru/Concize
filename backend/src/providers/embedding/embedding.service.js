// embeddingService.js
'use strict';

const config = require('../../core/config');
const geminiService = require('../llm/gemini'); // Key Rotation
const { runResilient } = require('../llm/resilient.inference');
const { createLogger } = require('../../core/logger');

const logger = createLogger('embeddingService');

if (!config?.inference?.geminiKeys || config.inference.geminiKeys.length === 0) {
    logger.warn('GEMINI_API_KEYS not set in config. Embeddings will fail.');
}

// Preferred embedding model (Gemini Embedding)
const MODEL_ID = 'gemini-embedding-001';

// Default embedding dimensionality
const DEFAULT_OUTPUT_DIMENSIONALITY = 768;

/**
 * Calls the embedding endpoint on the GoogleGenAI SDK.
 * Uses the official models.embedContent() method.
 *
 * @param {Object} aiInstance - The GoogleGenAI instance to use
 * @param {Object} params - parameters to pass to the SDK call.
 * @returns {Promise<any>} sdkResponse
 */
async function _callEmbeddingEndpoint(aiInstance, params) {
    // Validate SDK method exists and is a function
    if (!aiInstance?.models?.embedContent || typeof aiInstance.models.embedContent !== 'function') {
        const availableKeys = Object.keys(aiInstance?.models || {}).join(', ') || 'none';
        throw new Error(
            `Expected 'models.embedContent' method not found on @google/genai client. ` +
            `Available model methods: [${availableKeys}]. ` +
            `Ensure @google/genai SDK is up-to-date.`
        );
    }

    return await aiInstance.models.embedContent(params);
}

/**
 * Extracts an embedding vector array from multiple possible SDK response shapes.
 *
 * Supported target shapes (examples):
 *  - { embedding: { values: [...] } }
 *  - { embeddings: [ { values: [...] }, ... ] }
 *  - { data: [ { embedding: [ ... ] } ] }
 *  - { output: { embeddings: [ ... ] } }
 *
 * @param {any} sdkResp
 * @returns {number[]|null}
 */
function _extractEmbeddingVector(sdkResp) {
    if (!sdkResp) return null;

    // Common: sdkResp.embedding.values
    if (sdkResp.embedding && Array.isArray(sdkResp.embedding.values)) {
        return sdkResp.embedding.values;
    }

    // Some variants: sdkResp.embeddings is an array of embeddings with .values
    if (Array.isArray(sdkResp.embeddings) && sdkResp.embeddings.length > 0) {
        const first = sdkResp.embeddings[0];
        if (first && Array.isArray(first.values)) return first.values;
        if (Array.isArray(first)) return first; // maybe embeddings: [[...]]
    }

    // LangChain / older: sdkResp.data[0].embedding or sdkResp.data[0].embedding.values
    if (Array.isArray(sdkResp.data) && sdkResp.data.length > 0) {
        const d0 = sdkResp.data[0];
        if (!d0) return null;
        if (Array.isArray(d0.embedding)) return d0.embedding;
        if (d0.embedding && Array.isArray(d0.embedding.values)) return d0.embedding.values;
    }

    // Some SDKs wrap results under output
    if (sdkResp.output) {
        // output.embeddings = [[...]] or [{ values: [...] }]
        if (Array.isArray(sdkResp.output.embeddings) && sdkResp.output.embeddings.length > 0) {
            const e0 = sdkResp.output.embeddings[0];
            if (Array.isArray(e0)) return e0;
            if (e0 && Array.isArray(e0.values)) return e0.values;
        }

        // output.embedding
        if (sdkResp.output.embedding && Array.isArray(sdkResp.output.embedding.values)) {
            return sdkResp.output.embedding.values;
        }
    }

    // As a last-resort: check top-level arrays
    if (Array.isArray(sdkResp) && sdkResp.length > 0 && Array.isArray(sdkResp[0])) {
        return sdkResp[0];
    }

    return null;
}

/**
 * Generates a vector embedding for a given text using the Gemini API (robust across SDK variants).
 * @param {string} text - The input text to embed.
 * @param {Object} [opts] - Optional settings:
 *   - outputDimensionality: number (preferred)
 *   - model: model id override
 * @returns {Promise<number[]>}
 */
const getEmbedding = async (text, opts = {}) => {
    if (typeof text !== 'string' || !text.trim()) {
        throw new TypeError('getEmbedding expects a non-empty string as text.');
    }

    const model = opts.model || MODEL_ID;
    const outputDimensionality = typeof opts.outputDimensionality === 'number'
        ? opts.outputDimensionality
        : DEFAULT_OUTPUT_DIMENSIONALITY;

    try {
        logger.debug(`Requesting embedding`, { model, outputDimensionality });

        // Get rotated client instance
        const aiInstance = geminiService.getClient();
        if (!aiInstance) {
            throw new Error('Failed to obtain Gemini client instance. Check GEMINI_API_KEYS configuration.');
        }

        const params = {
            model,
            // some SDKs accept 'contents' as a string or array; send the canonical contents array
            contents: [{ parts: [{ text }] }],
            config: {
                outputDimensionality,
            },
        };

        // Call the SDK (tries multiple possible method names)
        const sdkResponse = await _callEmbeddingEndpoint(aiInstance, params);

        // Attempt to extract the vector from the response
        const vector = _extractEmbeddingVector(sdkResponse);

        if (!Array.isArray(vector) || vector.length === 0) {
            const responseShape = (sdkResponse && typeof sdkResponse === 'object')
                ? Object.keys(sdkResponse)
                : String(sdkResponse);
            logger.error('Unexpected embedding response shape', { responseShape });
            throw new Error('Embedding response did not contain a usable vector. Inspect logs for SDK response shape.');
        }

        logger.debug('Embedding generated', { vectorLength: vector.length });
        return vector;

    } catch (error) {
        logger.error('Error generating embedding', { error: error && (error.message || error) });
        throw error;
    }
};

/**
 * Wraps getEmbedding with full-jitter, Retry-After-aware retry (429 + 5xx).
 * Replaces the previous synchronized exponential backoff (a retry-storm risk under load).
 * @param {string} text
 * @param {Object} [opts]
 * @param {number} [maxRetries=3]
 * @returns {Promise<number[]>}
 */
const getEmbeddingWithRetry = async (text, opts = {}, maxRetries = 3) => {
    // Routed through the per-provider concurrency limiter + circuit breaker + jittered retry.
    return runResilient('gemini', () => getEmbedding(text, opts), {
        maxRetries,
        baseDelayMs: 1000,
        capDelayMs: 20000,
    });
};

module.exports = { getEmbedding, getEmbeddingWithRetry };
