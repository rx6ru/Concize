// tests/vectorSearchService.test.js
// Verifies retrieval is scoped by BOTH jobId and ownerId (defense-in-depth tenant isolation).

jest.mock('@qdrant/js-client-rest', () => {
    const search = jest.fn().mockResolvedValue([{ payload: { jobId: 'job-1' } }]);
    return { QdrantClient: jest.fn(() => ({ search })), __search: search };
});
jest.mock('../services/embedding/embeddingService', () => ({
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));
jest.mock('../configs/appConfig', () => ({
    database: { QDRANT_URL: 'http://qdrant', QDRANT_API_KEY: 'key' },
    TRANSCRIPTION_COLLECTION: 'transcriptions',
    CHAT_COLLECTION: 'chats',
}));

const qdrant = require('@qdrant/js-client-rest');
const { queryTranscriptions, queryChats } = require('../services/retrieval/vectorSearchService');

beforeEach(() => qdrant.__search.mockClear());

describe('vectorSearchService tenant scoping', () => {
    it('queryTranscriptions filters by jobId AND ownerId', async () => {
        await queryTranscriptions('hello', 'job-1', 'user-A', 5);
        const opts = qdrant.__search.mock.calls[0][1];
        expect(opts.filter.must).toEqual(expect.arrayContaining([
            { key: 'jobId', match: { value: 'job-1' } },
            { key: 'ownerId', match: { value: 'user-A' } },
        ]));
    });

    it('queryChats filters by jobId AND ownerId', async () => {
        await queryChats('hello', 'job-1', 'user-A', 3);
        const opts = qdrant.__search.mock.calls[0][1];
        expect(opts.filter.must).toEqual(expect.arrayContaining([
            { key: 'jobId', match: { value: 'job-1' } },
            { key: 'ownerId', match: { value: 'user-A' } },
        ]));
    });

    it('omits the owner filter when ownerId is absent (legacy safety: still jobId-scoped)', async () => {
        await queryTranscriptions('hello', 'job-1', undefined, 5);
        const opts = qdrant.__search.mock.calls[0][1];
        expect(opts.filter.must).toEqual([{ key: 'jobId', match: { value: 'job-1' } }]);
    });
});
