// Lexical chunk search against a real Postgres.
// pg-mem has no full text search, so this suite skips itself unless TEST_POSTGRES_URL points
// at a live database (docker-compose.dev.yml gives you one).

const { Pool } = require('pg');

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'unused' } }));
jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fs = require('fs');
const path = require('path');
const { _setPoolForTesting, closePool, query } = require('../src/infra/postgres');
const { insertChunk, searchChunkText } = require('../src/transcript/chunk.repository');

const URL = process.env.TEST_POSTGRES_URL;
const describeIfPg = URL ? describe : describe.skip;

if (!URL) {
    // eslint-disable-next-line no-console
    console.log('chunk.text.search: skipped, set TEST_POSTGRES_URL to run');
}

const chunk = (ordinal, text, over = {}) => ({
    layer: 1, ordinal, rev: 0,
    t0Ms: ordinal * 1000, t1Ms: ordinal * 1000 + 900,
    text, contextPrefix: '', speakers: ['S1'], ...over,
});

describeIfPg('lexical chunk search', () => {
    let pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: URL });
        _setPoolForTesting(pool);
        const schema = fs.readFileSync(path.join(__dirname, '../src/infra/schema.sql'), 'utf8')
            .replace(/ALTER TABLE[^;]*ENABLE ROW LEVEL SECURITY;/gi, '');
        await query(schema);
    });

    beforeEach(async () => {
        await query('DELETE FROM meetings WHERE job_id LIKE $1', ['fts-%']);
        await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['fts-1', 'user-A']);
    });

    afterAll(async () => {
        await query('DELETE FROM meetings WHERE job_id LIKE $1', ['fts-%']);
        await closePool();
    });

    it('finds a chunk by an exact token the way embeddings would not', async () => {
        await insertChunk('fts-1', chunk(0, 'we should revisit the pricing model next quarter'));
        await insertChunk('fts-1', chunk(1, 'Priya will file ticket PROJ-4417 before Friday'));

        const hits = await searchChunkText('fts-1', { text: 'PROJ-4417' });

        expect(hits).toHaveLength(1);
        expect(hits[0].text).toContain('PROJ-4417');
    });

    it('ranks the better lexical match first', async () => {
        await insertChunk('fts-1', chunk(0, 'pricing came up once'));
        await insertChunk('fts-1', chunk(1, 'pricing pricing pricing, the whole pricing model'));

        const hits = await searchChunkText('fts-1', { text: 'pricing model' });

        expect(hits[0].ordinal).toBe(1);
    });

    it('returns the shape the dense lane returns, so fusion does not care which engine ran', async () => {
        await insertChunk('fts-1', chunk(0, 'deployment instructions are in the runbook',
            { speakers: ['S2', 'S3'], hasOverlap: true }));

        const [hit] = await searchChunkText('fts-1', { text: 'runbook' });

        expect(hit).toMatchObject({
            layer: 1, ordinal: 0, rev: 0, t0Ms: 0, t1Ms: 900,
            speakers: ['S2', 'S3'], hasOverlap: true,
        });
        expect(typeof hit.score).toBe('number');
    });

    it('searches the context prefix too, not just the words spoken', async () => {
        await insertChunk('fts-1', chunk(0, 'yeah that works for me',
            { contextPrefix: '[Q3 roadmap planning | 0:00-0:30 | Speakers: S1]' }));

        const hits = await searchChunkText('fts-1', { text: 'roadmap' });
        expect(hits).toHaveLength(1);
    });

    it('scopes to one meeting', async () => {
        await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['fts-2', 'user-B']);
        await insertChunk('fts-1', chunk(0, 'shared keyword here'));
        await insertChunk('fts-2', chunk(0, 'shared keyword here'));

        expect(await searchChunkText('fts-1', { text: 'keyword' })).toHaveLength(1);
    });

    it('will not return another tenant chunk even with the right meeting id', async () => {
        await insertChunk('fts-1', chunk(0, 'confidential keyword'));

        expect(await searchChunkText('fts-1', { text: 'keyword', ownerId: 'user-A' })).toHaveLength(1);
        expect(await searchChunkText('fts-1', { text: 'keyword', ownerId: 'user-B' })).toHaveLength(0);
    });

    it('returns only the latest revision of a chunk', async () => {
        await insertChunk('fts-1', chunk(0, 'original wording mentions widgets'));
        await insertChunk('fts-1', chunk(0, 'corrected wording mentions widgets', { rev: 1 }));

        const hits = await searchChunkText('fts-1', { text: 'widgets' });

        expect(hits).toHaveLength(1);
        expect(hits[0].rev).toBe(1);
    });

    it('filters by layer when asked', async () => {
        await insertChunk('fts-1', chunk(0, 'summary mentions budget', { layer: 2 }));
        await insertChunk('fts-1', chunk(0, 'verbatim mentions budget', { layer: 1 }));

        expect(await searchChunkText('fts-1', { text: 'budget', layer: 1 })).toHaveLength(1);
        expect(await searchChunkText('fts-1', { text: 'budget' })).toHaveLength(2);
    });

    it('respects the limit', async () => {
        for (let i = 0; i < 5; i++) await insertChunk('fts-1', chunk(i, `mentions budget ${i}`));

        expect(await searchChunkText('fts-1', { text: 'budget', limit: 2 })).toHaveLength(2);
    });

    it('returns nothing rather than everything for an empty query', async () => {
        await insertChunk('fts-1', chunk(0, 'something was said'));

        expect(await searchChunkText('fts-1', { text: '' })).toEqual([]);
        expect(await searchChunkText('fts-1', { text: '   ' })).toEqual([]);
    });

    it('matches on any query term, not all of them', async () => {
        // a real question shares only a word or two with the chunk that answers it
        await insertChunk('fts-1', chunk(0, 'the budget is fixed for now'));

        await expect(searchChunkText('fts-1', { text: "what's the budget?! (roughly)" }))
            .resolves.toHaveLength(1);
    });

    it('ranks the chunk matching more of the query above one matching less', async () => {
        await insertChunk('fts-1', chunk(0, 'budget was mentioned'));
        await insertChunk('fts-1', chunk(1, 'the budget for the roadmap was approved'));

        const hits = await searchChunkText('fts-1', { text: 'budget roadmap approved' });
        expect(hits[0].ordinal).toBe(1);
    });

    it('cannot be broken by tsquery syntax in the question', async () => {
        await insertChunk('fts-1', chunk(0, 'the budget is fixed'));

        for (const q of ['budget & | !', '(((', 'budget <-> :*', "'; DROP TABLE chunks; --"]) {
            await expect(searchChunkText('fts-1', { text: q })).resolves.toEqual(expect.any(Array));
        }
        // and the table is still there
        expect(await searchChunkText('fts-1', { text: 'budget' })).toHaveLength(1);
    });

    it('matches code-mixed text, which is why the index is simple and not english', async () => {
        await insertChunk('fts-1', chunk(0, 'pricing ke baare me kal decide karenge'));

        expect(await searchChunkText('fts-1', { text: 'karenge' })).toHaveLength(1);
    });

    // Sharing (meeting_shares) grants a reader access at the HTTP layer; it never changes how
    // retrieval is scoped. requireMeetingAccess always resolves req.meeting.ownerId to the
    // meeting's true owner (see meeting.access.js), so this is the ownerId every retrieval
    // lane, including this one, actually queries with — a shared reader's own id never
    // reaches here. Nested in the same describe so it shares the live pool's lifecycle.
    describe('sharing does not loosen retrieval scoping', () => {
        beforeEach(async () => {
            await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['fts-3', 'user-C']);
        });

        afterEach(async () => {
            await query('DELETE FROM meetings WHERE job_id = $1', ['fts-3']);
        });

        it("a shared reader's query, scoped to the meeting's true owner, returns that meeting's chunks", async () => {
            await insertChunk('fts-1', chunk(0, 'the roadmap review happens on Thursday'));

            // A shared reader's request still carries the meeting's true owner as ownerId
            // (requireMeetingAccess never substitutes the caller's own id), so this is what
            // retrieval actually runs with.
            const hits = await searchChunkText('fts-1', { text: 'roadmap', ownerId: 'user-A' });

            expect(hits).toHaveLength(1);
        });

        it("never returns another meeting's chunks, even one owned by the same reader", async () => {
            await insertChunk('fts-1', chunk(0, 'quarterly numbers are strong'));
            await insertChunk('fts-3', chunk(0, 'quarterly numbers are strong'));

            // fts-1 (owned by user-A) and fts-3 (owned by user-C) could both be shared with the
            // same reader; each query is still scoped to one meeting's true owner at a time.
            expect(await searchChunkText('fts-1', { text: 'quarterly', ownerId: 'user-A' })).toHaveLength(1);
            expect(await searchChunkText('fts-1', { text: 'quarterly', ownerId: 'user-C' })).toHaveLength(0);
            expect(await searchChunkText('fts-3', { text: 'quarterly', ownerId: 'user-A' })).toHaveLength(0);
        });

        it("a wrong implementation that scoped by the reader's own id instead of the owner's would find nothing", async () => {
            await insertChunk('fts-1', chunk(0, 'the migration plan ships next sprint'));

            // 'reader-B' is not fts-1's owner; if requireMeetingAccess ever passed the
            // caller's id through as ownerId instead of the meeting's true owner, this is the
            // failure mode: an authorized shared reader would retrieve nothing from their own
            // shared meeting.
            expect(await searchChunkText('fts-1', { text: 'migration', ownerId: 'reader-B' })).toHaveLength(0);
        });
    });
});
