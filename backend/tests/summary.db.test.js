// tests/summary.db.test.js
// Real SQL of the Postgres summary layer against pg-mem, including the transactional
// in-order reservation (startSummaryUpdate) that replaced the Mongo race workaround.

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
let mem;

jest.mock('../configs/appConfig', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));

const { _setPoolForTesting, closePool, query } = require('../db/pg');
const {
    getMeetingSummary,
    startSummaryUpdate,
    saveSummaryContent,
    completeSummary,
} = require('../db/mongoutils/summary.db');

beforeEach(async () => {
    mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
    // Parent meeting (FK target for meeting_summaries).
    await query("INSERT INTO meetings (job_id, owner_id) VALUES ('job-1', 'user-A')");
});
afterEach(async () => { await closePool(); });

describe('summary.db (Postgres)', () => {
    it('getMeetingSummary returns null before any update', async () => {
        expect(await getMeetingSummary('job-1')).toBeNull();
    });

    it('startSummaryUpdate(0) creates the row with status=updating, version=1', async () => {
        const s = await startSummaryUpdate('job-1', 0);
        expect(s.status).toBe('updating');
        expect(s.version).toBe(1);
        expect(s.lastProcessedChunkIndex).toBe(-1);
        expect(s.title).toBe('New Meeting');
    });

    it('rejects a non-zero first chunk (missing start)', async () => {
        await expect(startSummaryUpdate('job-1', 3)).rejects.toThrow(/missing start/i);
    });

    it('processes chunks strictly in order, rejecting out-of-order', async () => {
        await startSummaryUpdate('job-1', 0);
        await saveSummaryContent('job-1', { title: 'T0', summary: 'C0' }, 0);

        // Next valid chunk is 1; chunk 2 must be rejected.
        await expect(startSummaryUpdate('job-1', 2)).rejects.toThrow(/out of order/i);

        // Chunk 1 proceeds and bumps version.
        const s1 = await startSummaryUpdate('job-1', 1);
        expect(s1.version).toBe(2);
        expect(s1.content).toBe('C0'); // prior content preserved for incremental update
    });

    it('saveSummaryContent persists title/content and advances the chunk index', async () => {
        await startSummaryUpdate('job-1', 0);
        await saveSummaryContent('job-1', { title: 'My Title', summary: 'Body text' }, 0);

        const s = await getMeetingSummary('job-1');
        expect(s.title).toBe('My Title');
        expect(s.content).toBe('Body text');
        expect(s.lastProcessedChunkIndex).toBe(0);
        expect(s.status).toBe('updating');
    });

    it('completeSummary marks status complete', async () => {
        await startSummaryUpdate('job-1', 0);
        await completeSummary('job-1');
        expect((await getMeetingSummary('job-1')).status).toBe('complete');
    });
});
