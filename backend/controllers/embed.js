// embed.js

// Using require to be consistent with the rest of your files
const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../utils/config');
const { getEmbedding } = require('./embeddingService'); // We will use this to get the vector from text

const client = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
});

// Name of your collection in Qdrant
const COLLECTION_NAME = config.COLLECTION;

// This function will create the collection if it doesn't exist
const createCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === COLLECTION_NAME);
        
        if (!collectionExists) {
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 768, // THIS MUST MATCH THE GEMINI EMBEDDING MODEL'S OUTPUT VECTOR SIZE
                    distance: 'Cosine',
                },
            });
            console.log(`Collection '${COLLECTION_NAME}' created successfully.`);
        } else {
            console.log(`Collection '${COLLECTION_NAME}' already exists.`);
        }
    } catch (err) {
        console.error('Error creating or checking collection:', err);
        // Depending on the error, you might want to throw it to stop the process
        throw err;
    }
};

// Main function to embed the text and upsert the point into Qdrant
const upsertTranscriptionChunk = async (pointId, text, metadata) => {
    try {
        // Step 1: Generate the embedding vector for the text
        const vector = await getEmbedding(text);
        
        if (!vector || vector.length === 0) {
            throw new Error("Embedding vector could not be generated.");
        }

        // Step 2: Upsert the point into the collection
        const result = await client.upsert(COLLECTION_NAME, {
            wait: true, // Wait for the operation to be finished
            points: [
                {
                    id: pointId,
                    vector: vector,
                    payload: {
                        ...metadata,
                        text: text // Store the original text in the payload for RAG
                    },
                },
            ],
        });

        return { success: true, result: result };

    } catch (err) {
        console.error('Error during upsert operation:', err);
        return { success: false, error: err.message };
    }
};

// Export the functions to be used by other modules
module.exports = {
    upsertTranscriptionChunk,
    createCollection,
};