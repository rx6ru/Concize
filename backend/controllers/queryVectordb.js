// queryVectordb.js

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../utils/config'); // Adjust path based on your project structure
const { getEmbedding } = require('./embedding/embeddingService'); // Reusing the existing embedding service

// Initialize Qdrant client
const client = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
});

// Collection names from config
const TRANSCRIPTION_COLLECTION_NAME = config.TRANSCRIPTION_COLLECTION;
const CHAT_COLLECTION_NAME = config.CHAT_COLLECTION;

/**
 * Queries the 'transcriptions' Qdrant collection for semantically similar chunks
 * related to the user's prompt within a specific meeting.
 *
 * @param {string} userPrompt - The user's query text.
 * @param {string} jobId - The jobId to filter transcription chunks by.
 * @param {number} [limit=5] - The maximum number of relevant transcription chunks to retrieve.
 * @returns {Promise<Array<Object>>} An array of relevant transcription chunk payloads.
 */
const queryTranscriptions = async (userPrompt, jobId, limit = 5) => {
    try {
        console.log(`Qdrant: Querying '${TRANSCRIPTION_COLLECTION_NAME}' for jobId: ${jobId} with prompt: "${userPrompt.substring(0, 50)}..."`);
        
        const queryVector = await getEmbedding(userPrompt);

        if (!queryVector || queryVector.length === 0) {
            console.warn('Qdrant: Failed to generate embedding for user prompt. Skipping transcription query.');
            return [];
        }

        const searchResult = await client.search(TRANSCRIPTION_COLLECTION_NAME, {
            vector: queryVector,
            filter: {
                must: [
                    {
                        key: "jobId", // Assuming jobId is stored in the payload of transcription chunks
                        match: {
                            value: jobId,
                        },
                    },
                ],
            },
            limit: limit,
            with_payload: true, // Return the stored payload
            with_vectors: false, // Don't return the vectors, just the payload
        });

        console.log(`Qdrant: Found ${searchResult.length} relevant transcription chunks.`);
        // Extract and return only the payload from the search results
        return searchResult.map(hit => hit.payload);

    } catch (err) {
        console.error('Qdrant: Error querying transcription collection:', err);
        throw err;
    }
};

/**
 * Queries the 'chats' Qdrant collection for semantically similar chat pairs
 * related to the user's prompt within a specific meeting's conversation history.
 *
 * @param {string} userPrompt - The user's query text.
 * @param {string} jobId - The jobId to filter chat pairs by.
 * @param {number} [limit=3] - The maximum number of relevant chat pairs to retrieve.
 * @returns {Promise<Array<Object>>} An array of relevant chat pair payloads (userChat, aiChat).
 */
const queryChats = async (userPrompt, jobId, limit = 3) => {
    try {
        console.log(`Qdrant: Querying '${CHAT_COLLECTION_NAME}' for jobId: ${jobId} with prompt: "${userPrompt.substring(0, 50)}..."`);

        const queryVector = await getEmbedding(userPrompt);

        if (!queryVector || queryVector.length === 0) {
            console.warn('Qdrant: Failed to generate embedding for user prompt. Skipping chat history query.');
            return [];
        }

        const searchResult = await client.search(CHAT_COLLECTION_NAME, {
            vector: queryVector,
            filter: {
                must: [
                    {
                        key: "jobId", // Assuming jobId is stored in the payload of chat pairs
                        match: {
                            value: jobId,
                        },
                    },
                ],
            },
            limit: limit,
            with_payload: true, // Return the stored payload
            with_vectors: false, // Don't return the vectors, just the payload
        });

        console.log(`Qdrant: Found ${searchResult.length} relevant chat history entries.`);
        // Extract and return only the payload from the search results
        return searchResult.map(hit => hit.payload);

    } catch (err) {
        console.error('Qdrant: Error querying chat collection:', err);
        throw err;
    }
};

module.exports = {
    queryTranscriptions,
    queryChats,
};
