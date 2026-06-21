// services/embedding/transcriptionEmbedding.js
// Handles embedding narrative chunks into Qdrant with enriched metadata payloads.

'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../../configs/appConfig');
const { getEmbeddingWithRetry } = require('./embeddingService');
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
 * Also creates payload indexes for efficient filtered search.
 */
const createTranCollection = async () => {
    try {
        const collections = await client.getCollections();
        const collectionExists = collections.collections.some(c => c.name === COLLECTION_NAME);

        if (!collectionExists) {
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 768, // Matches gemini-embedding-001
                    distance: 'Cosine',
                },
            });
            logger.info('Collection created', { collection: COLLECTION_NAME });
        } else {
            logger.info('Collection already exists', { collection: COLLECTION_NAME });
        }

        // Create payload indexes for filtered vector search.
        // These are idempotent — safe to call even if index already exists.
        const indexes = [
            { field_name: 'jobId', field_schema: 'keyword' },
            { field_name: 'ownerId', field_schema: 'keyword' },
            { field_name: 'speakers', field_schema: 'keyword' },
            { field_name: 'startTime', field_schema: 'float' },
            { field_name: 'endTime', field_schema: 'float' },
            { field_name: 'mentionedNames', field_schema: 'keyword' },
            { field_name: 'provider', field_schema: 'keyword' },
        ];

        for (const idx of indexes) {
            try {
                await client.createPayloadIndex(COLLECTION_NAME, idx);
            } catch (idxErr) {
                // Index may already exist — that's fine
                if (!idxErr.message?.includes('already exists')) {
                    logger.warn('Failed to create payload index', {
                        field: idx.field_name,
                        error: idxErr.message,
                    });
                }
            }
        }

        logger.info('Payload indexes ensured', {
            collection: COLLECTION_NAME,
            indexes: indexes.map(i => i.field_name),
        });

    } catch (err) {
        logger.error('Error creating or checking transcription collection', { error: err.message });
        throw err;
    }
};

/**
 * Generates embeddings for narrative chunks and upserts them into Qdrant
 * with enriched metadata payloads.
 *
 * @param {string} jobId - The meeting session ID.
 * @param {Array<{ summary: string, narrative: string, mentionedNames: string[] }>} chunks
 *   Cleaned chunks from cleanService.
 * @param {Object} metadata - Enriched metadata from the orchestrator:
 *   @param {string}   metadata.originalname
 *   @param {string}   metadata.uploadTimestamp
 *   @param {number}   [metadata.startTime]
 *   @param {number}   [metadata.endTime]
 *   @param {string[]} [metadata.speakers]
 *   @param {string}   [metadata.provider]
 *   @param {string}   [metadata.language]
 *   @param {number}   [metadata.chunkIndex]
 * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
 */
const upsertTranscriptionChunks = async (jobId, chunks, metadata) => {
    try {
        await createTranCollection();

        if (!chunks || chunks.length === 0) {
            logger.warn('No chunks to upsert');
            return { success: true, result: null };
        }

        const points = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            // Embed the NARRATIVE (natural prose, no speaker labels)
            const textToEmbed = chunk.narrative || chunk.refined_text || '';
            if (!textToEmbed.trim()) {
                logger.warn('Skipping chunk with empty narrative', { index: i });
                continue;
            }

            const vector = await getEmbeddingWithRetry(textToEmbed);
            if (!vector || vector.length === 0) {
                logger.error('Skipping chunk due to failed embedding', { index: i });
                continue;
            }

            points.push({
                id: uuidv4(),
                vector,
                payload: {
                    // Core content
                    jobId,
                    ownerId: metadata.ownerId ?? null, // tenant isolation
                    narrative: textToEmbed,
                    summary: chunk.summary || '',

                    // Names extracted from dialogue
                    mentionedNames: chunk.mentionedNames || [],

                    // File metadata
                    filename: metadata.originalname,
                    uploadTimestamp: metadata.uploadTimestamp,

                    // Temporal metadata (for time-range filtering)
                    startTime: metadata.startTime ?? null,
                    endTime: metadata.endTime ?? null,

                    // Speaker metadata (for multi-party filtering)
                    speakers: metadata.speakers || [],

                    // Chunk position
                    chunkIndex: metadata.chunkIndex ?? i,

                    // Provider tracking
                    provider: metadata.provider || 'unknown',
                    language: metadata.language || null,
                },
            });
        }

        if (points.length === 0) {
            logger.warn('No points were successfully prepared for upsert');
            return { success: false, error: 'No valid points to upsert.' };
        }

        const result = await client.upsert(COLLECTION_NAME, {
            wait: true,
            points,
        });

        logger.info('Upserted transcription chunks', {
            count: points.length,
            jobId,
            provider: metadata.provider,
            hasNames: points.some(p => p.payload.mentionedNames.length > 0),
        });

        return { success: true, result };

    } catch (err) {
        logger.error('Error during upsert operation', {
            error: err.message,
            jobId,
        });
        return { success: false, error: err.message };
    }
};

module.exports = {
    upsertTranscriptionChunks,
    createTranCollection,
};
