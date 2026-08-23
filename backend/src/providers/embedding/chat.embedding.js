const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../core/config');
const { getEmbedding } = require('./embedding.service');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../core/logger');

const logger = createLogger('chatEmbedding');

const client = new QdrantClient({
    url: config.database.QDRANT_URL,
    apiKey: config.database.QDRANT_API_KEY,
    timeout: 60000,
    checkCompatibility: false, // skip the version-check round-trip on construction
});

const CHAT_COLLECTION_NAME = config.database.CHAT_COLLECTION;

// Vector size (768) must match the 'gemini-embedding-001' model's output.
const createChatCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === CHAT_COLLECTION_NAME);

        if (!collectionExists) {
            await client.createCollection(CHAT_COLLECTION_NAME, {
                vectors: {
                    size: 768,
                    distance: 'Cosine',
                },
            });
            logger.info(`Collection created successfully`, { collection: CHAT_COLLECTION_NAME });

            await client.createPayloadIndex(CHAT_COLLECTION_NAME, {
                field_name: 'jobId',
                field_schema: 'keyword'
            });
            await client.createPayloadIndex(CHAT_COLLECTION_NAME, {
                field_name: 'ownerId',
                field_schema: 'keyword'
            });
            logger.info(`Payload indexes created for 'jobId' and 'ownerId'`, { collection: CHAT_COLLECTION_NAME });

        } else {
            logger.info(`Collection already exists`, { collection: CHAT_COLLECTION_NAME });
        }
    } catch (err) {
        logger.error('Error creating or checking chat collection', { error: err.message });
        throw err;
    }
};

// Embeds the combined user+AI text so the vector captures the full conversational context. chatId cross-references the chat row; ownerId stamps tenant isolation.
const upsertChatPair = async (jobId, userChat, aiChat, chatId, ownerId) => {
    try {
        const combinedChatText = `User: ${userChat}\nAI response: ${aiChat}`;
        const vector = await getEmbedding(combinedChatText);

        if (!vector || vector.length === 0) {
            logger.error(`Skipping chat pair embedding due to failed embedding`, { jobId, chatId });
            return { success: false, error: "Failed to generate embedding for chat pair." };
        }

        const point = {
            id: uuidv4(), // always a new UUID, reusing an id would overwrite an existing point
            vector: vector,
            payload: {
                jobId: jobId,
                ownerId: ownerId ?? null,
                mongoId: chatId,
                userChat: userChat,
                aiChat: aiChat,
                timestamp: new Date().toISOString(),
            },
        };

        const result = await client.upsert(CHAT_COLLECTION_NAME, {
            wait: true,
            points: [point],
        });

        logger.info(`Successfully upserted chat pair`, { jobId, mongoId: chatId });
        return { success: true, result: result };

    } catch (err) {
        logger.error('Error during upsert operation for chat pair', { error: err.message });
        return { success: false, error: err.message };
    }
};

/** Removes every chat vector for one meeting. Payload key is jobId, not meetingId, as written above. */
async function purgeChatVectors(jobId) {
    await client.delete(CHAT_COLLECTION_NAME, {
        wait: true,
        filter: { must: [{ key: 'jobId', match: { value: jobId } }] },
    });
    logger.info('Chat vectors purged', { jobId });
}

module.exports = {
    createChatCollection,
    upsertChatPair,
    purgeChatVectors,
};
