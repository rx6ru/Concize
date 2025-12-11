// embeddingService.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../utils/config');

// Initialize the Google Generative AI client with the API key
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// Select the embedding model - using gemini-embedding-001 (stable, replaces deprecated embedding-001)
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

// Output dimension for embeddings (768 via Matryoshka Representation Learning)
// gemini-embedding-001 supports 768, 1536, or 3072 dimensions
const OUTPUT_DIMENSIONALITY = 768;

/**
 * Generates a vector embedding for a given text using the Gemini API.
 * @param {string} text The input text to be embedded.
 * @returns {Promise<number[]>} A promise that resolves to an array of numbers representing the vector embedding.
 */
const getEmbedding = async (text) => {
    try {
        console.log("EMBEDDING_LOG: Calling Gemini gemini-embedding-001 API...");

        // The Gemini SDK's method for embeddings with output dimensionality control
        const result = await embeddingModel.embedContent({
            content: { parts: [{ text }] },
            outputDimensionality: OUTPUT_DIMENSIONALITY,
        });

        const vector = result.embedding.values;

        // Log the vector size for confirmation
        console.log("EMBEDDING_LOG: Embedding generated successfully. Vector size:", vector.length);

        return vector;

    } catch (error) {
        console.error("EMBEDDING_ERROR: Error generating embedding:", error);
        throw error;
    }
};

module.exports = { getEmbedding };