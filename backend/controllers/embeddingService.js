// embeddingService.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../utils/config');

// Initialize the Google Generative AI client with the API key
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// Select the embedding model
const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });

/**
 * Generates a vector embedding for a given text using the Gemini API.
 * @param {string} text The input text to be embedded.
 * @returns {Promise<number[]>} A promise that resolves to an array of numbers representing the vector embedding.
 */
const getEmbedding = async (text) => {
    try {
        console.log("EMBEDDING_LOG: Calling Google Gemini API for embedding...");

        // The Gemini SDK's method for embeddings
        const { embedding } = await embeddingModel.embedContent(text);

        const vector = embedding.values;

        // Log the vector size for confirmation. The size is 768 for embedding-001.
        console.log("EMBEDDING_LOG: Embedding generated successfully. Vector size:", vector.length);

        return vector;

    } catch (error) {
        console.error("EMBEDDING_ERROR: Error generating embedding:", error);
        throw error;
    }
};

module.exports = { getEmbedding };