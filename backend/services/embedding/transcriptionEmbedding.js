// services/embedding/transcriptionEmbedding.js

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../configs/appConfig');
const { getEmbedding } = require('./embeddingService');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('transcriptionEmbedding');

const client = new QdrantClient({
    url: config.database.QDRANT_URL,
    apiKey: config.database.QDRANT_API_KEY,
    timeout: 60000,
});

const COLLECTION_NAME = config.database.TRANSCRIPTION_COLLECTION;

/**
 * Creates the Qdrant collection for transcriptions if it doesn't already exist.
 * The vector size (768) must match the 'gemini-embedding-001' model's output.
 */
const createTranCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === COLLECTION_NAME);

        if (!collectionExists) {
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 768, // Matches the gemini-embedding-001 model
                    distance: 'Cosine',
                },
            });
            logger.info(`Collection created successfully`, { collection: COLLECTION_NAME });

            // CRITICAL FIX: Add a payload index on the 'jobId' field for efficient filtering.
            await client.createPayloadIndex(COLLECTION_NAME, {
                field_name: 'jobId',
                field_schema: 'keyword'
            });
            logger.info(`Payload index created for 'jobId'`, { collection: COLLECTION_NAME });

        } else {
            logger.info(`Collection already exists`, { collection: COLLECTION_NAME });
        }
    } catch (err) {
        logger.error('Error creating or checking transcription collection', { error: err.message });
        throw err;
    }
};

/**
 * Generates embeddings for an array of text chunks and upserts them into Qdrant.
 * This function first ensures the collection exists before attempting the upsert.
 * @param {string} jobId - The unique ID of the meeting session.
 * @param {Array<Object>} chunks An array of objects, where each object has a 'summary' and 'refined_text' property.
 * @param {Object} metadata The metadata to be associated with each point (e.g., originalname, uploadTimestamp).
 * @returns {Promise<Object>} A promise that resolves to the result of the upsert operation.
 */
const upsertTranscriptionChunks = async (jobId, chunks, metadata) => {
    try {
        // First, ensure the collection exists
        await createTranCollection();

        if (!chunks || chunks.length === 0) {
            logger.warn("No chunks to upsert");
            return { success: true, result: null };
        }

        const points = [];
        for (const chunk of chunks) {
            const vector = await getEmbedding(chunk.refined_text);

            if (!vector || vector.length === 0) {
                logger.error(`Skipping chunk due to failed embedding`, { chunkText: chunk.refined_text });
                continue;
            }

            points.push({
                id: uuidv4(),
                vector: vector,
                payload: {
                    jobId: jobId,
                    filename: metadata.originalname,
                    uploadTimestamp: metadata.uploadTimestamp,
                    text: chunk.refined_text,
                    summary: chunk.summary,
                },
            });
        }

        if (points.length === 0) {
            logger.warn("No points were successfully prepared for upsert");
            return { success: false, error: "No valid points to upsert." };
        }

        const result = await client.upsert(COLLECTION_NAME, {
            wait: true,
            points: points,
        });

        logger.info(`Successfully upserted transcription chunks`, { count: points.length, jobId });
        return { success: true, result: result };

    } catch (err) {
        logger.error('Error during upsert operation for transcription chunks', { error: err.message });
        return { success: false, error: err.message };
    }
};

module.exports = {
    upsertTranscriptionChunks,
    createTranCollection,
};
