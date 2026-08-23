jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// The module under test builds its own QdrantClient at require time (no dependency
// injection like chunk.search.js has), so the client has to be faked at the package
// boundary. The jest.fn()s live inside the factory (nothing from outer scope) so this
// survives jest's mock hoisting.
jest.mock('@qdrant/js-client-rest', () => {
    const upsert = jest.fn();
    const getCollections = jest.fn();
    const createCollection = jest.fn();
    const createPayloadIndex = jest.fn();
    return {
        QdrantClient: jest.fn().mockImplementation(() => ({
            upsert, getCollections, createCollection, createPayloadIndex,
        })),
        __mocks: { upsert, getCollections, createCollection, createPayloadIndex },
    };
});

jest.mock('../src/providers/embedding/embedding.service', () => ({
    getEmbedding: jest.fn(),
}));

const config = require('../src/core/config');
const { __mocks: qdrant } = require('@qdrant/js-client-rest');
const { getEmbedding } = require('../src/providers/embedding/embedding.service');
const { upsertChatPair, createChatCollection } = require('../src/providers/embedding/chat.embedding');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A fake upsert that is only as strict as necessary would be exactly how a bad id
// shipped last time, so this rejects anything that is not the id shape real Qdrant
// accepts (unsigned int or uuid).
function strictUpsert(collection, body) {
    const id = body.points[0].id;
    const isUnsignedInt = /^\d+$/.test(String(id));
    if (!isUnsignedInt && !UUID_V4.test(String(id))) {
        return Promise.reject(new Error(`400: point id "${id}" is not an unsigned int or a UUID`));
    }
    return Promise.resolve({ status: 'completed', operation_id: 1 });
}

beforeEach(() => {
    getEmbedding.mockReset();
    getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

    qdrant.upsert.mockReset();
    qdrant.upsert.mockImplementation(strictUpsert);

    qdrant.getCollections.mockReset();
    qdrant.getCollections.mockResolvedValue({ collections: [] });
    qdrant.createCollection.mockReset();
    qdrant.createCollection.mockResolvedValue();
    qdrant.createPayloadIndex.mockReset();
    qdrant.createPayloadIndex.mockResolvedValue();
});

const run = (ownerId = 'user-A') =>
    upsertChatPair('job-1', 'What is the deadline?', 'The deadline is Friday.', 'chat-42', ownerId);

describe('tenant isolation via ownerId', () => {
    it('stamps the caller-supplied ownerId onto the payload', async () => {
        await run('user-A');
        const payload = qdrant.upsert.mock.calls[0][1].points[0].payload;
        expect(payload.ownerId).toBe('user-A');
    });

    it('keeps two owners on two distinct points instead of merging them', async () => {
        await run('user-A');
        await run('user-B');
        const owners = qdrant.upsert.mock.calls.map((c) => c[1].points[0].payload.ownerId);
        expect(owners).toEqual(['user-A', 'user-B']);
    });

    it('records ownerId as null, not omitted, when the caller passes undefined', async () => {
        // Call upsertChatPair directly: run()'s default parameter would swallow an
        // explicit undefined before it ever reached the function under test.
        await upsertChatPair('job-1', 'What is the deadline?', 'The deadline is Friday.', 'chat-42', undefined);
        const payload = qdrant.upsert.mock.calls[0][1].points[0].payload;
        expect(payload).toHaveProperty('ownerId', null);
    });

    it('records ownerId as null when the caller passes null', async () => {
        await run(null);
        const payload = qdrant.upsert.mock.calls[0][1].points[0].payload;
        expect(payload).toHaveProperty('ownerId', null);
    });
});

describe('point id format', () => {
    it('assigns the qdrant point a real uuid v4, the shape qdrant actually accepts', async () => {
        await run();
        const id = qdrant.upsert.mock.calls[0][1].points[0].id;
        expect(id).toMatch(UUID_V4);
    });

    it('assigns a fresh id per call instead of deriving one from the chat id', async () => {
        await run();
        await run();
        const [id1, id2] = qdrant.upsert.mock.calls.map((c) => c[1].points[0].id);
        expect(id1).not.toBe(id2);
    });

    it('is rejected by a strict qdrant fake if the id were ever the raw chat id instead of a uuid', async () => {
        // Sanity check on the fake itself: a non-uuid, non-integer id must fail,
        // otherwise this suite could not have caught the id-format bug at all.
        await expect(strictUpsert('chats', { points: [{ id: 'chat-42' }] })).rejects.toThrow(/not an unsigned int or a UUID/);
    });
});

describe('text sent to the embedding provider', () => {
    it('embeds the combined user question and ai answer as one string', async () => {
        await run();
        expect(getEmbedding).toHaveBeenCalledWith('User: What is the deadline?\nAI response: The deadline is Friday.');
    });

    it('does not embed the user question alone', async () => {
        await run();
        expect(getEmbedding).not.toHaveBeenCalledWith('What is the deadline?');
    });
});

describe('payload contents for retrieval', () => {
    it('carries jobId, the chat row id and both raw chat turns', async () => {
        await run('user-A');
        const payload = qdrant.upsert.mock.calls[0][1].points[0].payload;
        expect(payload).toMatchObject({
            jobId: 'job-1',
            mongoId: 'chat-42',
            userChat: 'What is the deadline?',
            aiChat: 'The deadline is Friday.',
        });
    });

    it('stamps an iso-8601 timestamp on the payload', async () => {
        await run();
        const payload = qdrant.upsert.mock.calls[0][1].points[0].payload;
        expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('waits for the qdrant write to be indexed', async () => {
        await run();
        expect(qdrant.upsert.mock.calls[0][1].wait).toBe(true);
    });
});

describe('successful upsert', () => {
    it('resolves with the qdrant result wrapped in a success flag', async () => {
        const fakeResult = { status: 'completed', operation_id: 7 };
        qdrant.upsert.mockImplementationOnce(async () => fakeResult);
        const result = await run();
        expect(result).toEqual({ success: true, result: fakeResult });
    });
});

describe('failure isolation', () => {
    it('resolves a failure result instead of throwing when the embedding provider rejects', async () => {
        getEmbedding.mockRejectedValueOnce(new Error('gemini down'));
        const result = await run();
        expect(result).toEqual({ success: false, error: 'gemini down' });
    });

    it('does not touch qdrant when the embedding provider rejects', async () => {
        getEmbedding.mockRejectedValueOnce(new Error('gemini down'));
        await run();
        expect(qdrant.upsert).not.toHaveBeenCalled();
    });

    it('resolves a failure result instead of throwing when the embedding provider returns an empty vector', async () => {
        getEmbedding.mockResolvedValueOnce([]);
        const result = await run();
        expect(result).toEqual({ success: false, error: 'Failed to generate embedding for chat pair.' });
    });

    it('does not touch qdrant when the embedding provider returns an empty vector', async () => {
        getEmbedding.mockResolvedValueOnce([]);
        await run();
        expect(qdrant.upsert).not.toHaveBeenCalled();
    });

    it('resolves a failure result instead of throwing when the embedding provider returns nothing', async () => {
        getEmbedding.mockResolvedValueOnce(undefined);
        const result = await run();
        expect(result).toEqual({ success: false, error: 'Failed to generate embedding for chat pair.' });
    });

    it('resolves a failure result instead of throwing when the qdrant upsert rejects', async () => {
        qdrant.upsert.mockImplementationOnce(async () => { throw new Error('qdrant timeout'); });
        const result = await run();
        expect(result).toEqual({ success: false, error: 'qdrant timeout' });
    });

    it('still generates the embedding before a qdrant failure occurs', async () => {
        qdrant.upsert.mockImplementationOnce(async () => { throw new Error('qdrant timeout'); });
        await run();
        expect(getEmbedding).toHaveBeenCalledTimes(1);
    });

    it('rejects the caller with a real 400-shaped error when the id qdrant received is invalid', async () => {
        // Locks the strict fake to the documented real-Qdrant behaviour: this must
        // still surface as a caught, non-throwing failure result, never an uncaught throw.
        qdrant.upsert.mockImplementationOnce(() => strictUpsert('chats', { points: [{ id: 'not-a-uuid' }] }));
        const result = await run();
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not an unsigned int or a UUID/);
    });
});

describe('createChatCollection', () => {
    it('creates the collection and both payload indexes when missing', async () => {
        qdrant.getCollections.mockResolvedValueOnce({ collections: [] });
        await createChatCollection();

        expect(qdrant.createCollection).toHaveBeenCalledWith(config.database.CHAT_COLLECTION, {
            vectors: { size: 768, distance: 'Cosine' },
        });
        const fields = qdrant.createPayloadIndex.mock.calls.map((c) => c[1].field_name);
        expect(fields).toEqual(['jobId', 'ownerId']);
    });

    it('does not recreate the collection when it already exists', async () => {
        qdrant.getCollections.mockResolvedValueOnce({ collections: [{ name: config.database.CHAT_COLLECTION }] });
        await createChatCollection();
        expect(qdrant.createCollection).not.toHaveBeenCalled();
    });

    it('propagates a qdrant failure instead of swallowing it, unlike upsertChatPair', async () => {
        qdrant.getCollections.mockRejectedValueOnce(new Error('qdrant unreachable'));
        await expect(createChatCollection()).rejects.toThrow('qdrant unreachable');
    });
});

describe('the chat collection is created before it is written to', () => {
    // Nothing called createChatCollection, and upsertChatPair did not create it either, so every
    // write hit a collection that did not exist and chat history never worked in either direction.
    it('ensures the collection on the first upsert', async () => {
        const { __mocks } = require('@qdrant/js-client-rest');
        const { upsertChatPair } = require('../src/providers/embedding/chat.embedding');

        __mocks.getCollections.mockResolvedValue({ collections: [] });
        __mocks.createCollection.mockResolvedValue(true);
        __mocks.createPayloadIndex.mockResolvedValue(true);
        __mocks.upsert.mockResolvedValue({ status: 'completed' });

        await upsertChatPair('m1', 'q', 'a', 'c1', 'owner-1');

        expect(__mocks.createCollection).toHaveBeenCalled();
        expect(__mocks.upsert).toHaveBeenCalled();
    });

    it('does not recreate a collection that already exists', async () => {
        const { __mocks } = require('@qdrant/js-client-rest');
        const { upsertChatPair } = require('../src/providers/embedding/chat.embedding');
        jest.clearAllMocks();

        __mocks.getCollections.mockResolvedValue({ collections: [{ name: 'chats' }] });
        __mocks.upsert.mockResolvedValue({ status: 'completed' });

        await upsertChatPair('m1', 'q', 'a', 'c2', 'owner-1');

        expect(__mocks.createCollection).not.toHaveBeenCalled();
        expect(__mocks.upsert).toHaveBeenCalled();
    });
});
