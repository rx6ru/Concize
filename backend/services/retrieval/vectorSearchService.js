// queryVectordb.js

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../configs/appConfig');
const { getEmbedding } = require('../embedding/embeddingService');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('vectorSearchService');

// Initialize Qdrant client
const client = new QdrantClient({
    url: config.database.QDRANT_URL,
    apiKey: config.database.QDRANT_API_KEY,
    timeout: 60000,
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
        logger.debug(`Querying transcriptions`, { collection: TRANSCRIPTION_COLLECTION_NAME, jobId, promptSnippet: userPrompt.substring(0, 50) });

        const queryVector = await getEmbedding(userPrompt);

        if (!queryVector || queryVector.length === 0) {
            logger.warn('Failed to generate embedding for user prompt. Skipping transcription query');
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

        logger.debug(`Found relevant transcription chunks`, { count: searchResult.length });
        // Extract and return only the payload from the search results
        return searchResult.map(hit => hit.payload);

    } catch (err) {
        logger.error('Error querying transcription collection', { error: err.message });
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
        logger.debug(`Querying chat history`, { collection: CHAT_COLLECTION_NAME, jobId, promptSnippet: userPrompt.substring(0, 50) });

        const queryVector = await getEmbedding(userPrompt);

        if (!queryVector || queryVector.length === 0) {
            logger.warn('Failed to generate embedding for user prompt. Skipping chat history query');
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

        logger.debug(`Found relevant chat history entries`, { count: searchResult.length });
        // Extract and return only the payload from the search results
        return searchResult.map(hit => hit.payload);

    } catch (err) {
        logger.error('Error querying chat collection', { error: err.message });
        throw err;
    }
};

module.exports = {
    queryTranscriptions,
    queryChats,
};
