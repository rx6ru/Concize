// embeddingService.js
const { OpenAI } = require('openai');

// Initialize the client with the Trelent base URL
const openai = new OpenAI({
    // Use the Trelent API base URL
    apiBase: 'https://api.opentextembeddings.com/v1',
    // The Trelent API is free and does not require an API key,
    // but the SDK still requires one, so we can use a placeholder.
    apiKey: 'sk-trelent-key', 
});

/**
 * Generates a vector embedding for a given text using Trelent's API.
 * @param {string} text The input text to be embedded.
 * @returns {Promise<number[]>} A promise that resolves to an array of numbers representing the vector embedding.
 */
const getEmbedding = async (text) => {
    try {
        const cleanedText = text.replace(/\n/g, ' ');

        const response = await openai.embeddings.create({
            // Choose one of the supported models. This example uses bge-large-en
            model: "bge-large-en",
            input: cleanedText,
        });

        const embedding = response.data[0].embedding;

        // NOTE: The size of this vector is 1024, which requires a change in your embed.js file
        console.log("Embedding generated successfully. Vector size:", embedding.length);
        
        return embedding;

    } catch (error) {
        console.error("Error generating embedding:", error);
        throw error;
    }
};

module.exports = { getEmbedding };