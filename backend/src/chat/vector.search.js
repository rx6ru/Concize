const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../core/config');
const { getEmbedding } = require('../providers/embedding/embedding.service');
const { createLogger } = require('../core/logger');

const logger = createLogger('vectorSearch');

const client = new QdrantClient({
    url: config.database.QDRANT_URL,
    apiKey: config.database.QDRANT_API_KEY,
    timeout: 60000,
    checkCompatibility: false, // skip the version-check round-trip on construction
});

const TRANSCRIPTION_COLLECTION_NAME = config.TRANSCRIPTION_COLLECTION;
const CHAT_COLLECTION_NAME = config.CHAT_COLLECTION;

/**
 * Queries the 'transcriptions' Qdrant collection for chunks similar to the user's prompt within a specific meeting.
 * @param {string} ownerId - filter by owner (defense-in-depth tenant isolation).
 */
// Fail closed: dropping the owner filter when ownerId is missing would fall back to scoping by jobId alone, the bearer-capability model ADR-001 replaced (where knowing an id meant access).
function requireOwner(ownerId, where) {
    if (!ownerId) throw new Error(`${where}: ownerId is required; refusing to search unscoped`);
}

const queryTranscriptions = async (userPrompt, jobId, ownerId, limit = 5) => {
    requireOwner(ownerId, 'queryTranscriptions');
    try {
        logger.debug(`Querying transcriptions`, { collection: TRANSCRIPTION_COLLECTION_NAME, jobId, promptSnippet: userPrompt.substring(0, 50) });

        const queryVector = await getEmbedding(userPrompt);

        if (!queryVector || queryVector.length === 0) {
            logger.warn('Failed to generate embedding for user prompt. Skipping transcription query');
            return [];
        }

        const must = [{ key: 'jobId', match: { value: jobId } }];
        must.push({ key: 'ownerId', match: { value: ownerId } });

        const searchResult = await client.search(TRANSCRIPTION_COLLECTION_NAME, {
            vector: queryVector,
            filter: { must },
            limit: limit,
            with_payload: true,
            with_vectors: false,
        });

        logger.debug(`Found relevant transcription chunks`, { count: searchResult.length });
        return searchResult.map(hit => hit.payload);

    } catch (err) {
        logger.error('Error querying transcription collection', { error: err.message });
        throw err;
    }
};

/**
 * Queries the 'chats' Qdrant collection for chat pairs similar to the user's prompt within a meeting's history.
 * @param {string} ownerId - filter by owner (defense-in-depth tenant isolation).
 */
const queryChats = async (userPrompt, jobId, ownerId, limit = 3) => {
    requireOwner(ownerId, 'queryChats');
    try {
        logger.debug(`Querying chat history`, { collection: CHAT_COLLECTION_NAME, jobId, promptSnippet: userPrompt.substring(0, 50) });

        const queryVector = await getEmbedding(userPrompt);

        if (!queryVector || queryVector.length === 0) {
            logger.warn('Failed to generate embedding for user prompt. Skipping chat history query');
            return [];
        }

        const must = [{ key: 'jobId', match: { value: jobId } }];
        must.push({ key: 'ownerId', match: { value: ownerId } });

        const searchResult = await client.search(CHAT_COLLECTION_NAME, {
            vector: queryVector,
            filter: { must },
            limit: limit,
            with_payload: true,
            with_vectors: false,
        });

        logger.debug(`Found relevant chat history entries`, { count: searchResult.length });
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
