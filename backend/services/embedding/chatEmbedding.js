// embedChat.js

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../configs/appConfig');
const { getEmbedding } = require('./embeddingService'); // Reusing the existing embedding service
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('chatEmbedding');

// Initialize Qdrant client
const client = new QdrantClient({
    url: config.database.QDRANT_URL,
    apiKey: config.database.QDRANT_API_KEY,
    timeout: 60000,
});

// Define the collection name for chat embeddings
const CHAT_COLLECTION_NAME = config.database.CHAT_COLLECTION; // This will be a new env variable

/**
 * Creates the Qdrant collection for chat embeddings if it doesn't already exist.
 * The vector size (768) must match the 'gemini-embedding-001' model's output.
 */
const createChatCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === CHAT_COLLECTION_NAME);

        if (!collectionExists) {
            // Step 1: Create the collection first. This is where your vectors and payload will live.
            await client.createCollection(CHAT_COLLECTION_NAME, {
                vectors: {
                    size: 768,
                    distance: 'Cosine',
                },
            });
            logger.info(`Collection created successfully`, { collection: CHAT_COLLECTION_NAME });

            // Step 2: Now, add the index. This is the new, critical part.
            // The `createPayloadIndex` function tells Qdrant to build an index on a specific field within the payload.
            await client.createPayloadIndex(CHAT_COLLECTION_NAME, {
                field_name: 'jobId',
                field_schema: 'keyword'
            });
            logger.info(`Payload index created for 'jobId'`, { collection: CHAT_COLLECTION_NAME });

        } else {
            logger.info(`Collection already exists`, { collection: CHAT_COLLECTION_NAME });
        }
    } catch (err) {
        logger.error('Error creating or checking chat collection', { error: err.message });
        throw err;
    }
};

/**
 * Generates an embedding for a user-AI chat pair and upserts it into the chat Qdrant collection.
 * This function embeds the combined text of the user's query and the AI's response
 * to capture the full conversational context.
 *
 * @param {string} jobId - The jobId associated with the meeting session.
 * @param {string} userChat - The user's message.
 * @param {string} aiChat - The AI's response to the user's message.
 * @param {string} chatId - The MongoDB _id of the chat pair, used as Qdrant point ID.
 * @returns {Promise<Object>} A promise that resolves to the result of the upsert operation.
 */
const upsertChatPair = async (jobId, userChat, aiChat, chatId) => {
    try {
        // Combine user and AI chat for a comprehensive embedding
        const combinedChatText = `User: ${userChat}\nAI response: ${aiChat}`;
        const vector = await getEmbedding(combinedChatText);

        if (!vector || vector.length === 0) {
            logger.error(`Skipping chat pair embedding due to failed embedding`, { jobId, chatId });
            return { success: false, error: "Failed to generate embedding for chat pair." };
        }

        const point = {
            id: uuidv4(), // CRITICAL FIX: Always use a new UUID for the Qdrant point ID
            vector: vector,
            payload: {
                jobId: jobId,
                mongoId: chatId, // Store the MongoDB _id here for future reference
                userChat: userChat,
                aiChat: aiChat,
                timestamp: new Date().toISOString(), // Store timestamp of embedding
            },
        };

        const result = await client.upsert(CHAT_COLLECTION_NAME, {
            wait: true, // Wait for the operation to be finished
            points: [point],
        });

        logger.info(`Successfully upserted chat pair`, { jobId, mongoId: chatId });
        return { success: true, result: result };

    } catch (err) {
        logger.error('Error during upsert operation for chat pair', { error: err.message });
        return { success: false, error: err.message };
    }
};

module.exports = {
    createChatCollection,
    upsertChatPair,
};
