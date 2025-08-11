// embedChat.js

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../utils/config'); // Adjust path based on your project structure
const { getEmbedding } = require('./embeddingService'); // Reusing the existing embedding service
const { v4: uuidv4 } = require('uuid');

// Initialize Qdrant client
const client = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
});

// Define the collection name for chat embeddings
const CHAT_COLLECTION_NAME = config.CHAT_COLLECTION; // This will be a new env variable

/**
 * Creates the Qdrant collection for chat embeddings if it doesn't already exist.
 * The vector size (768) must match the 'embedding-001' model's output.
 */
const createChatCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === CHAT_COLLECTION_NAME);
        
        if (!collectionExists) {
            await client.createCollection(CHAT_COLLECTION_NAME, {
                vectors: {
                    size: 768, // Matches the embedding-001 model
                    distance: 'Cosine',
                },
            });
            console.log(`Qdrant: Collection '${CHAT_COLLECTION_NAME}' created successfully for chat embeddings.`);
        } else {
            console.log(`Qdrant: Collection '${CHAT_COLLECTION_NAME}' already exists for chat embeddings.`);
        }
    } catch (err) {
        console.error('Qdrant: Error creating or checking chat collection:', err);
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
            console.error(`Qdrant: Skipping chat pair embedding due to failed embedding for jobId: ${jobId}, chatId: ${chatId}`);
            return { success: false, error: "Failed to generate embedding for chat pair." };
        }

        const point = {
            id: chatId || uuidv4(), // Use MongoDB _id as Qdrant ID for easy lookup, fallback to new UUID
            vector: vector,
            payload: {
                jobId: jobId,
                userChat: userChat,
                aiChat: aiChat,
                timestamp: new Date().toISOString(), // Store timestamp of embedding
            },
        };

        const result = await client.upsert(CHAT_COLLECTION_NAME, {
            wait: true, // Wait for the operation to be finished
            points: [point],
        });

        console.log(`Qdrant: Successfully upserted chat pair for jobId: ${jobId}, chatId: ${chatId}`);
        return { success: true, result: result };

    } catch (err) {
        console.error('Qdrant: Error during upsert operation for chat pair:', err);
        return { success: false, error: err.message };
    }
};

module.exports = {
    createChatCollection,
    upsertChatPair,
};
