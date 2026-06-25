jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createChunkSearch, VECTOR_SIZE } = require('../src/chat/chunk.search');

function fakeClient(over = {}) {
    return {
        getCollections: jest.fn(async () => ({ collections: [] })),
        createCollection: jest.fn(async () => {}),
        createPayloadIndex: jest.fn(async () => {}),
        upsert: jest.fn(async () => {}),
        search: jest.fn(async () => []),
        delete: jest.fn(async () => {}),
        ...over,
    };
}

const hit = (over = {}) => ({
    id: 'm1:1:0:0', score: 0.9,
    payload: {
        layer: 1, ordinal: 0, rev: 0, t0Ms: 0, t1Ms: 5000,
        text: 'pricing discussion', speakers: ['S1'], hasOverlap: false, ...over,
    },
});

const make = (over = {}) => {
    const client = fakeClient(over.client);
    const embed = over.embed || jest.fn(async () => new Array(VECTOR_SIZE).fill(0.1));
    return { client, embed, search: createChunkSearch({ client, embed }) };
};

describe('collection setup', () => {
    it('creates the collection with the embedding dimension', async () => {
        const { client, search } = make();
        expect(await search.ensureCollection()).toBe(true);
        expect(client.createCollection).toHaveBeenCalledWith('concize_chunks', {
            vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
        });
    });

    it('indexes the fields every query filters on', async () => {
        const { client, search } = make();
        await search.ensureCollection();
        const fields = client.createPayloadIndex.mock.calls.map((c) => c[1].field_name);
        expect(fields).toEqual(['meetingId', 'ownerId']);
    });

    it('is a no-op when the collection exists', async () => {
        const { client, search } = make({
            client: { getCollections: jest.fn(async () => ({ collections: [{ name: 'concize_chunks' }] })) },
        });
        expect(await search.ensureCollection()).toBe(false);
        expect(client.createCollection).not.toHaveBeenCalled();
    });

    it('still creates the collection when an index fails', async () => {
        const { search } = make({
            client: { createPayloadIndex: jest.fn(async () => { throw new Error('exists'); }) },
        });
        await expect(search.ensureCollection()).resolves.toBe(true);
    });
});

describe('search', () => {
    it('always filters by meeting and owner', async () => {
        const { client, search } = make({ client: { search: jest.fn(async () => []) } });
        await search.denseSearch({ query: 'q', meetingId: 'm1', ownerId: 'user-A', layer: 1 });

        const { filter } = client.search.mock.calls[0][1];
        expect(filter.must).toEqual(expect.arrayContaining([
            { key: 'meetingId', match: { value: 'm1' } },
            { key: 'ownerId', match: { value: 'user-A' } },
            { key: 'layer', match: { value: 1 } },
        ]));
    });

    it('still filters by meeting when no owner is supplied', async () => {
        const { client, search } = make({ client: { search: jest.fn(async () => []) } });
        await search.denseSearch({ query: 'q', meetingId: 'm1' });

        const keys = client.search.mock.calls[0][1].filter.must.map((m) => m.key);
        expect(keys).toContain('meetingId');
        expect(keys).not.toContain('ownerId');
    });

    it('embeds the query before searching', async () => {
        const { embed, search } = make();
        await search.denseSearch({ query: 'what about pricing', meetingId: 'm1' });
        expect(embed).toHaveBeenCalledWith('what about pricing');
    });

    it('maps hits into the shape the retrieval pipeline expects', async () => {
        const { search } = make({ client: { search: jest.fn(async () => [hit()]) } });
        const [row] = await search.denseSearch({ query: 'q', meetingId: 'm1' });

        expect(row).toMatchObject({
            vectorId: 'm1:1:0:0', layer: 1, ordinal: 0, rev: 0,
            t0Ms: 0, t1Ms: 5000, text: 'pricing discussion', hasOverlap: false,
        });
        expect(row.speakers).toEqual(['S1']);
    });

    it('defaults missing payload arrays rather than returning undefined', async () => {
        const { search } = make({
            client: { search: jest.fn(async () => [{ id: 'x', score: 1, payload: { layer: 1 } }]) },
        });
        const [row] = await search.denseSearch({ query: 'q', meetingId: 'm1' });
        expect(row.speakers).toEqual([]);
        expect(row.hasOverlap).toBe(false);
    });

    it('throws when the query embedding is empty rather than searching with nothing', async () => {
        const { client, search } = make({ embed: jest.fn(async () => []) });
        await expect(search.denseSearch({ query: 'q', meetingId: 'm1' }))
            .rejects.toThrow(/no vector/);
        expect(client.search).not.toHaveBeenCalled();
    });

    it('honours the limit', async () => {
        const { client, search } = make({ client: { search: jest.fn(async () => []) } });
        await search.denseSearch({ query: 'q', meetingId: 'm1', limit: 5 });
        expect(client.search.mock.calls[0][1].limit).toBe(5);
    });
});

describe('upsert and purge', () => {
    it('upserts a point with its payload and waits for indexing', async () => {
        const { client, search } = make();
        await search.upsert('id-1', [0.1, 0.2], { meetingId: 'm1' });

        expect(client.upsert).toHaveBeenCalledWith('concize_chunks', {
            wait: true,
            points: [{ id: 'id-1', vector: [0.1, 0.2], payload: { meetingId: 'm1' } }],
        });
    });

    it('purges only the named meeting', async () => {
        const { client, search } = make();
        await search.purgeMeeting('m1');

        expect(client.delete.mock.calls[0][1].filter.must).toEqual([
            { key: 'meetingId', match: { value: 'm1' } },
        ]);
    });
});
