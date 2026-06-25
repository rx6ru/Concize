// Derived chunk storage against pg-mem, loading the real src/infra/schema.sql.

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const schema = fs.readFileSync(path.join(__dirname, '../src/infra/schema.sql'), 'utf8')
    .replace(/ALTER TABLE[^;]*ENABLE ROW LEVEL SECURITY;/gi, '');

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));
jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { _setPoolForTesting, closePool, query } = require('../src/infra/postgres');
const {
    insertChunk, getChunks, markDirtyForRange, getDirtyChunks, attachVector, getUnembedded,
} = require('../src/transcript/chunk.repository');

let mem;
beforeEach(async () => {
    mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m1', 'user-A']);
});
afterEach(async () => { await closePool(); });

const chunk = (ordinal, t0, t1, over = {}) => ({
    ordinal, t0Ms: t0, t1Ms: t1, text: `chunk ${ordinal}`,
    turnIds: [`t${ordinal}`], speakers: ['S1'], tokens: 100, ...over,
});

describe('insert and read', () => {
    it('round-trips a chunk including its arrays', async () => {
        const c = await insertChunk('m1', chunk(0, 0, 5000, {
            turnIds: ['t1', 't2'], speakers: ['S1', 'S2'], hasOverlap: true,
        }));
        expect(c).toMatchObject({
            layer: 1, ordinal: 0, rev: 0, hasOverlap: true, dirty: false, vectorId: null,
        });
        expect(c.turnIds).toEqual(['t1', 't2']);
        expect(c.speakers).toEqual(['S1', 'S2']);
    });

    it('returns chunks in spoken order', async () => {
        await insertChunk('m1', chunk(2, 20000, 25000));
        await insertChunk('m1', chunk(0, 0, 5000));
        await insertChunk('m1', chunk(1, 5000, 20000));

        expect((await getChunks('m1')).map((c) => c.ordinal)).toEqual([0, 1, 2]);
    });

    it('separates layers', async () => {
        await insertChunk('m1', chunk(0, 0, 5000, { layer: 1, text: 'verbatim' }));
        await insertChunk('m1', chunk(0, 0, 5000, { layer: 2, text: 'narrative' }));

        expect((await getChunks('m1', 1))[0].text).toBe('verbatim');
        expect((await getChunks('m1', 2))[0].text).toBe('narrative');
    });

    it('rejects a layer outside 1..3', async () => {
        await expect(insertChunk('m1', chunk(0, 0, 1, { layer: 9 }))).rejects.toThrow();
    });

    it('scopes reads to one meeting', async () => {
        await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m2', 'user-B']);
        await insertChunk('m1', chunk(0, 0, 5000));
        await insertChunk('m2', chunk(0, 0, 5000, { text: 'other tenant' }));

        const got = await getChunks('m1');
        expect(got).toHaveLength(1);
        expect(got[0].text).not.toBe('other tenant');
    });
});

describe('revisions', () => {
    it('returns only the latest revision of each chunk', async () => {
        await insertChunk('m1', chunk(0, 0, 5000, { text: 'v0' }));
        await insertChunk('m1', chunk(0, 0, 5000, { rev: 1, text: 'v1' }));

        const got = await getChunks('m1');
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ rev: 1, text: 'v1' });
    });

    it('keeps the superseded revision on disk for rebuild and audit', async () => {
        await insertChunk('m1', chunk(0, 0, 5000, { text: 'v0' }));
        await insertChunk('m1', chunk(0, 0, 5000, { rev: 1, text: 'v1' }));

        const { rows } = await query('SELECT rev FROM chunks WHERE meeting_id = $1 ORDER BY rev', ['m1']);
        expect(rows.map((r) => r.rev)).toEqual([0, 1]);
    });
});

describe('dirty marking', () => {
    it('flags chunks whose range intersects a correction', async () => {
        await insertChunk('m1', chunk(0, 0, 5000));
        await insertChunk('m1', chunk(1, 5000, 10000));
        await insertChunk('m1', chunk(2, 10000, 15000));

        const dirty = await markDirtyForRange('m1', 4000, 6000);
        expect(dirty.map((c) => c.ordinal).sort()).toEqual([0, 1]);
    });

    it('does not flag a chunk that merely touches the boundary', async () => {
        await insertChunk('m1', chunk(0, 0, 5000));
        expect(await markDirtyForRange('m1', 5000, 6000)).toEqual([]);
    });

    it('flags a chunk fully containing the corrected span', async () => {
        await insertChunk('m1', chunk(0, 0, 90000));
        expect((await markDirtyForRange('m1', 40000, 41000))).toHaveLength(1);
    });

    it('lists dirty chunks for the re-derivation worker', async () => {
        await insertChunk('m1', chunk(0, 0, 5000));
        await insertChunk('m1', chunk(1, 5000, 10000));
        await markDirtyForRange('m1', 0, 1000);

        const dirty = await getDirtyChunks('m1');
        expect(dirty).toHaveLength(1);
        expect(dirty[0].ordinal).toBe(0);
    });

    it('does not leak dirty chunks across meetings', async () => {
        await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m2', 'user-B']);
        await insertChunk('m1', chunk(0, 0, 5000));
        await insertChunk('m2', chunk(0, 0, 5000));
        await markDirtyForRange('m1', 0, 1000);

        expect(await getDirtyChunks('m2')).toEqual([]);
    });
});

describe('embedding lifecycle', () => {
    it('lists chunks with no vector yet', async () => {
        await insertChunk('m1', chunk(0, 0, 5000));
        expect(await getUnembedded('m1')).toHaveLength(1);
    });

    it('clears dirty and records the vector id when embedded', async () => {
        const c = await insertChunk('m1', chunk(0, 0, 5000));
        await markDirtyForRange('m1', 0, 1000);

        const updated = await attachVector('m1', c, 'vec-123');
        expect(updated).toMatchObject({ vectorId: 'vec-123', dirty: false });
        expect(await getUnembedded('m1')).toEqual([]);
        expect(await getDirtyChunks('m1')).toEqual([]);
    });

    it('returns null when the chunk revision does not exist', async () => {
        expect(await attachVector('m1', { layer: 1, ordinal: 99, rev: 0 }, 'v')).toBeNull();
    });

    it('attaches to one revision without touching the other', async () => {
        await insertChunk('m1', chunk(0, 0, 5000, { text: 'v0' }));
        const v1 = await insertChunk('m1', chunk(0, 0, 5000, { rev: 1, text: 'v1' }));
        await attachVector('m1', v1, 'vec-new');

        const { rows } = await query(
            'SELECT rev, vector_id FROM chunks WHERE meeting_id = $1 ORDER BY rev', ['m1']);
        expect(rows[0].vector_id).toBeNull();
        expect(rows[1].vector_id).toBe('vec-new');
    });
});
