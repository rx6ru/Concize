// db/mongoutils/embedTranscriptions.js

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../utils/config');
const { getEmbedding } = require('./embeddingService');
const { v4: uuidv4 } = require('uuid');

const client = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
});

const COLLECTION_NAME = config.TRANSCRIPTION_COLLECTION;

/**
 * Creates the Qdrant collection for transcriptions if it doesn't already exist.
 * The vector size (768) must match the 'embedding-001' model's output.
 */
const createTranCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === COLLECTION_NAME);
        
        if (!collectionExists) {
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 768, // Matches the embedding-001 model
                    distance: 'Cosine',
                },
            });
            console.log(`Qdrant: Collection '${COLLECTION_NAME}' created successfully for transcriptions.`);
        } else {
            console.log(`Qdrant: Collection '${COLLECTION_NAME}' already exists for transcriptions.`);
        }
    } catch (err) {
        console.error('Qdrant: Error creating or checking transcription collection:', err);
        throw err;
    }
};

/**
 * Generates embeddings for an array of text chunks and upserts them into Qdrant.
 * @param {string} jobId - The unique ID of the meeting session. (NEW PARAMETER)
 * @param {Array<Object>} chunks An array of objects, where each object has a 'summary' and 'refined_text' property.
 * @param {Object} metadata The metadata to be associated with each point (e.g., originalname, uploadTimestamp).
 * @returns {Promise<Object>} A promise that resolves to the result of the upsert operation.
 */
const upsertTranscriptionChunks = async (jobId, chunks, metadata) => { // jobId added here
    try {
        if (!chunks || chunks.length === 0) {
            console.warn("No chunks to upsert.");
            return { success: true, result: null };
        }

        const points = [];
        for (const chunk of chunks) {
            const vector = await getEmbedding(chunk.refined_text);
            
            if (!vector || vector.length === 0) {
                console.error(`Skipping chunk due to failed embedding: ${chunk.refined_text}`);
                continue;
            }

            points.push({
                id: uuidv4(),
                vector: vector,
                payload: {
                    jobId: jobId, // CRITICAL FIX: Add jobId to the payload
                    filename: metadata.originalname,
                    uploadTimestamp: metadata.uploadTimestamp,
                    text: chunk.refined_text,
                    summary: chunk.summary,
                },
            });
        }

        if (points.length === 0) {
            console.warn("No points were successfully prepared for upsert.");
            return { success: false, error: "No valid points to upsert." };
        }

        const result = await client.upsert(COLLECTION_NAME, {
            wait: true,
            points: points,
        });

        console.log(`Qdrant: Successfully upserted ${points.length} transcription chunks for jobId: ${jobId}.`);
        return { success: true, result: result };

    } catch (err) {
        console.error('Qdrant: Error during upsert operation for transcription chunks:', err);
        return { success: false, error: err.message };
    }
};

module.exports = {
    upsertTranscriptionChunks,
    createTranCollection,
};
