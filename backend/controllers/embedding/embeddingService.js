// embeddingService.js
'use strict';

const { GoogleGenAI } = require('@google/genai'); // confirm package installed
const config = require('../../utils/config');
const keyRotation = require('../../utils/keyRotation'); // Key Rotation

if (!config?.GEMINI_API_KEY && (!config?.GEMINI_API_KEYS || config.GEMINI_API_KEYS.length === 0)) {
    console.warn('WARNING: GEMINI_API_KEY(S) not set in config.');
}

// Preferred embedding model (Gemini Embedding)
const MODEL_ID = 'gemini-embedding-001';

// Default embedding dimensionality
const DEFAULT_OUTPUT_DIMENSIONALITY = 768;

/**
 * Attempts to call several likely SDK methods for generating embeddings,
 * returning the raw SDK response for further parsing.
 *
 * @param {Object} aiInstance - The GoogleGenAI instance to use
 * @param {Object} params - parameters to pass to the SDK call.
 * @returns {Promise<any>} sdkResponse
 */
async function _callEmbeddingEndpoint(aiInstance, params) {
    // Try multiple method names to be robust across SDK minor versions
    const candidateCalls = [
        // modern / canonical shapes
        () => aiInstance.models.embedContent?.(params),
        () => aiInstance.models.embed?.(params),
        () => aiInstance.models.embed_content?.(params),

        // some SDKs expose top-level client methods
        () => aiInstance.embedContent?.(params),
        () => aiInstance.embed?.(params),
        () => aiInstance.embed_content?.(params),
    ];

    let lastError = null;
    for (const call of candidateCalls) {
        try {
            if (typeof call !== 'function') continue;
            const res = await call();
            if (res !== undefined) return res;
        } catch (err) {
            lastError = err;
            // continue to next candidate
        }
    }

    // If we reach here, none of the calls succeeded
    const err = lastError ?? new Error('No embedding method found on the installed @google/genai client.');
    throw err;
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
        console.log(`EMBEDDING_LOG: Requesting embedding from model=${model} dim=${outputDimensionality}...`);

        // Get rotated key and instantiate client
        const currentKey = keyRotation.getNextKey();
        const aiInstance = new GoogleGenAI({ apiKey: currentKey });

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
            console.error('EMBEDDING_ERROR: Received unexpected embedding response shape:', JSON.stringify(sdkResponse && Object.keys(sdkResponse), null, 2));
            throw new Error('Embedding response did not contain a usable vector. Inspect logs for SDK response shape.');
        }

        console.log('EMBEDDING_LOG: Embedding generated. Vector length =', vector.length);
        return vector;

    } catch (error) {
        console.error('EMBEDDING_ERROR: Error generating embedding:', error && (error.message || error));
        throw error;
    }
};

module.exports = { getEmbedding };
