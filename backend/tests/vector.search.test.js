// tests/vectorSearchService.test.js
// Verifies retrieval is scoped by BOTH jobId and ownerId (defense-in-depth tenant isolation).

jest.mock('@qdrant/js-client-rest', () => {
    const search = jest.fn().mockResolvedValue([{ payload: { jobId: 'job-1' } }]);
    return { QdrantClient: jest.fn(() => ({ search })), __search: search };
});
jest.mock('../src/providers/embedding/embedding.service', () => ({
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));
jest.mock('../src/core/config', () => ({
    database: { QDRANT_URL: 'http://qdrant', QDRANT_API_KEY: 'key' },
    TRANSCRIPTION_COLLECTION: 'transcriptions',
    CHAT_COLLECTION: 'chats',
}));

const qdrant = require('@qdrant/js-client-rest');
const { queryTranscriptions, queryChats } = require('../src/chat/vector.search');

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

    // Was: "omits the owner filter when ownerId is absent (legacy safety: still jobId-scoped)".
    // Being scoped to a jobId is precisely the bearer-capability model ADR-001 abandoned —
    // possession of an id meant access. Dropping the filter is a fail-OPEN guard: a caller that
    // loses its ownerId silently searches the whole meeting instead of matching nothing. Every
    // production call site passes one (all three originate from requireMeetingAccess), so the
    // leniency protected nothing and only stood to convert a future regression into a leak.
    it('refuses to search without an owner rather than searching unscoped', async () => {
        await expect(queryTranscriptions('hello', 'job-1', undefined, 5))
            .rejects.toThrow(/ownerId/i);

        expect(qdrant.__search).not.toHaveBeenCalled();
    });

    it('refuses on the chat collection too', async () => {
        await expect(queryChats('hello', 'job-1', undefined, 3)).rejects.toThrow(/ownerId/i);
        expect(qdrant.__search).not.toHaveBeenCalled();
    });
});
