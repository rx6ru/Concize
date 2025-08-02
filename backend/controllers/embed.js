//embed.js

// Using require to be consistent with the rest of your files
const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../utils/config');
const { getEmbedding } = require('./embeddingService'); // We will use this to get the vector from text
const { v4: uuidv4 } = require('uuid');

const client = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
});

// Name of your collection in Qdrant
const COLLECTION_NAME = config.COLLECTION;

/**
 * Creates the Qdrant collection if it doesn't already exist.
 * This function uses the `embedding-001` model's vector size of 768.
 */
const createCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === COLLECTION_NAME);
       
        if (!collectionExists) {
            // Note: The size of 768 must match the embedding-001 model's output.
            // If you change the embedding model, this size must be updated.
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 768,
                    distance: 'Cosine',
                },
            });
            console.log(`Collection '${COLLECTION_NAME}' created successfully.`);
        } else {
            console.log(`Collection '${COLLECTION_NAME}' already exists.`);
        }
    } catch (err) {
        console.error('Error creating or checking collection:', err);
        throw err;
    }
};

/**
 * Generates embeddings for an array of text chunks and upserts them into Qdrant.
 * @param {Array<Object>} chunks An array of objects, where each object has a 'summary' and 'refined_text' property.
 * @param {Object} metadata The metadata to be associated with each point.
 * @returns {Promise<Object>} A promise that resolves to the result of the upsert operation.
 */
const upsertTranscriptionChunks = async (chunks, metadata) => {
    try {
        if (!chunks || chunks.length === 0) {
            console.warn("No chunks to upsert.");
            return { success: true, result: null };
        }

        // Filter and transform metadata to only include required fields
        const filteredMetadata = {
            filename: metadata.originalname,
            uploadTimestamp: metadata.uploadTimestamp
        };

        const points = [];
        for (const chunk of chunks) {
            // Tweak: Use chunk.refined_text instead of chunk.text
            const vector = await getEmbedding(chunk.refined_text);
           
            if (!vector || vector.length === 0) {
                console.error(`Skipping chunk due to failed embedding: ${chunk.refined_text}`);
                continue;
            }

            points.push({
                id: uuidv4(),
                vector: vector,
                payload: {
                    ...filteredMetadata,
                    text: chunk.refined_text, // Tweak: Store the refined text in the payload
                    summary: chunk.summary, // Add the summary to the payload
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

        return { success: true, result: result };

    } catch (err) {
        console.error('Error during upsert operation:', err);
        return { success: false, error: err.message };
    }
};

// Export the functions to be used by other modules
module.exports = {
    upsertTranscriptionChunks,
    createCollection,
};