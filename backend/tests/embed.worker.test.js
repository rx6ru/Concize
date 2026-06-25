jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createEmbedWorker } = require('../src/transcript/embed.worker');

const chunk = (over = {}) => ({
    layer: 1, ordinal: 0, rev: 0, t0Ms: 0, t1Ms: 5000,
    text: 'push it to next quarter', contextPrefix: '', speakers: ['S1'],
    hasOverlap: false, vectorId: null, dirty: false, ...over,
});

function makeWorker(over = {}) {
    const attached = [];
    const upserted = [];
    const deps = {
        getUnembedded: jest.fn(async () => []),
        getDirtyChunks: jest.fn(async () => []),
        attachVector: jest.fn(async (m, c, id) => { attached.push({ m, c, id }); return { ...c, vectorId: id }; }),
        embed: jest.fn(async () => [0.1, 0.2, 0.3]),
        upsert: jest.fn(async (id, vec, payload) => { upserted.push({ id, vec, payload }); }),
        ...over,
    };
    return { worker: createEmbedWorker(deps), attached, upserted, ...deps };
}

describe('embedding pass', () => {
    it('embeds chunks that have no vector yet', async () => {
        const w = makeWorker({ getUnembedded: async () => [chunk()] });
        const result = await w.worker.run('m1');

        expect(result).toMatchObject({ embedded: 1, failed: 0 });
        expect(w.embed).toHaveBeenCalledTimes(1);
        expect(w.upserted).toHaveLength(1);
    });

    it('embeds the contextualised text, not the bare chunk', async () => {
        const w = makeWorker({
            getUnembedded: async () => [chunk({ contextPrefix: '[Standup | 0:00–0:05]' })],
        });
        await w.worker.run('m1');

        expect(w.embed).toHaveBeenCalledWith('[Standup | 0:00–0:05]\npush it to next quarter');
    });

    it('builds a prefix when the chunk has none', async () => {
        const w = makeWorker({ getUnembedded: async () => [chunk()] });
        await w.worker.run('m1', { title: 'Q3 planning' });

        expect(w.embed.mock.calls[0][0]).toContain('[Q3 planning | 0:00–0:05 | Speakers: S1]');
    });

    it('also picks up chunks invalidated by a correction', async () => {
        const w = makeWorker({
            getDirtyChunks: async () => [chunk({ ordinal: 3, dirty: true })],
        });
        const result = await w.worker.run('m1');
        expect(result.embedded).toBe(1);
    });

    it('does not embed a chunk twice when it is both unembedded and dirty', async () => {
        const c = chunk({ dirty: true });
        const w = makeWorker({ getUnembedded: async () => [c], getDirtyChunks: async () => [c] });

        const result = await w.worker.run('m1');
        expect(result.embedded).toBe(1);
        expect(w.embed).toHaveBeenCalledTimes(1);
    });
});

describe('vector identity and payload', () => {
    // Qdrant rejects anything that is not an unsigned int or a uuid, with a bare 400.
    it('uses a uuid as the point id', async () => {
        const w = makeWorker({ getUnembedded: async () => [chunk({ layer: 2, ordinal: 7, rev: 3 })] });
        await w.worker.run('m1');
        expect(w.upserted[0].id)
            .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('uses a deterministic id so a re-embed overwrites instead of duplicating', () => {
        const w = makeWorker();
        const c = chunk({ layer: 2, ordinal: 7, rev: 3 });
        expect(w.worker.vectorIdFor('m1', c)).toBe(w.worker.vectorIdFor('m1', c));
    });

    it('gives different revisions different ids', () => {
        const w = makeWorker();
        expect(w.worker.vectorIdFor('m1', chunk({ rev: 0 })))
            .not.toBe(w.worker.vectorIdFor('m1', chunk({ rev: 1 })));
    });

    it('does not collide across meetings', () => {
        const w = makeWorker();
        expect(w.worker.vectorIdFor('m1', chunk())).not.toBe(w.worker.vectorIdFor('m2', chunk()));
    });

    it('keeps the readable key in the payload since the id is now a hash', async () => {
        const w = makeWorker({ getUnembedded: async () => [chunk({ layer: 2, ordinal: 7, rev: 3 })] });
        await w.worker.run('m1');
        expect(w.upserted[0].payload.chunkKey).toBe('m1:2:7:3');
    });

    it('stamps ownership into the payload for tenant isolation at the vector layer', async () => {
        const w = makeWorker({ getUnembedded: async () => [chunk()] });
        await w.worker.run('m1', { ownerId: 'user-A' });

        expect(w.upserted[0].payload).toMatchObject({ meetingId: 'm1', ownerId: 'user-A' });
    });

    it('carries overlap and speakers into the payload for retrieval-time hedging', async () => {
        const w = makeWorker({
            getUnembedded: async () => [chunk({ hasOverlap: true, speakers: ['S1', 'S2'] })],
        });
        await w.worker.run('m1');

        expect(w.upserted[0].payload).toMatchObject({ hasOverlap: true, speakers: ['S1', 'S2'] });
    });

    it('records ownerId as null rather than omitting it when unknown', async () => {
        const w = makeWorker({ getUnembedded: async () => [chunk()] });
        await w.worker.run('m1');
        expect(w.upserted[0].payload).toHaveProperty('ownerId', null);
    });
});

describe('failure handling', () => {
    it('records the vector only after the upsert succeeds', async () => {
        const w = makeWorker({
            getUnembedded: async () => [chunk()],
            upsert: jest.fn(async () => { throw new Error('qdrant down'); }),
        });
        const result = await w.worker.run('m1');

        expect(result).toMatchObject({ embedded: 0, failed: 1 });
        expect(w.attachVector).not.toHaveBeenCalled();   // would orphan the chunk
    });

    it('rejects an empty embedding instead of storing a useless vector', async () => {
        const w = makeWorker({
            getUnembedded: async () => [chunk()],
            embed: jest.fn(async () => []),
        });
        const result = await w.worker.run('m1');

        expect(result.failed).toBe(1);
        expect(result.failures[0].error).toMatch(/no vector/);
        expect(w.upsert).not.toHaveBeenCalled();
    });

    it('keeps going after one chunk fails', async () => {
        let call = 0;
        const w = makeWorker({
            getUnembedded: async () => [chunk({ ordinal: 0 }), chunk({ ordinal: 1 }), chunk({ ordinal: 2 })],
            embed: jest.fn(async () => {
                call += 1;
                if (call === 2) throw new Error('rate limited');
                return [0.1];
            }),
        });
        const result = await w.worker.run('m1');

        expect(result).toMatchObject({ embedded: 2, failed: 1 });
        expect(result.failures[0].ordinal).toBe(1);
    });

    it('leaves a failed chunk unembedded so the next pass retries it', async () => {
        const w = makeWorker({
            getUnembedded: async () => [chunk()],
            embed: jest.fn(async () => { throw new Error('boom'); }),
        });
        await w.worker.run('m1');
        expect(w.attachVector).not.toHaveBeenCalled();
    });

    it('reports nothing to do on an empty meeting', async () => {
        const w = makeWorker();
        expect(await w.worker.run('m1')).toMatchObject({ embedded: 0, failed: 0 });
    });
});
