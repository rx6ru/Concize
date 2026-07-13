// tests/transcription.db.test.js
// Exercises the REAL SQL of the Postgres transcription DB layer against pg-mem,
// loading the actual src/infra/schema.sql so the queries are validated end-to-end (no live DB).

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

// Build an in-memory Postgres, load the real schema, and inject its Pool into db/pg.js.
const { loadSchema } = require('./helpers/schema');

const schema = loadSchema();
let mem;

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));

const { _setPoolForTesting, closePool } = require('../src/infra/postgres');
const {
    createTranscription,
    getMeetingOwner,
    appendTranscription,
    getTranscription,
    updateMeetingStatus,
    getMeetingStatus,
} = require('../src/meetings/meeting.repository');

beforeEach(() => {
    mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
});

afterEach(async () => { await closePool(); });

describe('transcription.db (Postgres)', () => {
    describe('createTranscription / getMeetingOwner', () => {
        it('creates a meeting with an owner and resolves the owner', async () => {
            expect(await createTranscription('job-1', 'user-A')).toBe(true);
            expect(await getMeetingOwner('job-1')).toBe('user-A');
        });

        it('returns null owner for a non-existent meeting', async () => {
            expect(await getMeetingOwner('ghost')).toBeNull();
        });

        it('returns false when creating a duplicate jobId', async () => {
            await createTranscription('job-dup', 'user-A');
            expect(await createTranscription('job-dup', 'user-B')).toBe(false);
        });
    });

    describe('appendTranscription', () => {
        beforeEach(async () => { await createTranscription('job-1', 'user-A'); });

        it('assigns sequential chunk indexes starting at 0', async () => {
            expect(await appendTranscription('job-1', 'first')).toEqual({ success: true, chunkIndex: 0 });
            expect(await appendTranscription('job-1', 'second')).toEqual({ success: true, chunkIndex: 1 });
            expect(await appendTranscription('job-1', 'third')).toEqual({ success: true, chunkIndex: 2 });
        });

        it('fails (no crash) when the meeting does not exist (FK)', async () => {
            const res = await appendTranscription('ghost', 'x');
            expect(res.success).toBe(false);
            expect(res.chunkIndex).toBe(-1);
        });
    });

    describe('getTranscription', () => {
        it('returns status + ordered chunks', async () => {
            await createTranscription('job-1', 'user-A');
            await appendTranscription('job-1', 'a');
            await appendTranscription('job-1', 'b');

            const doc = await getTranscription('job-1');
            expect(doc.status).toBe('in-progress');
            expect(doc.transcriptionChunks).toEqual(['a', 'b']);
        });

        it('returns null when the meeting is missing', async () => {
            expect(await getTranscription('ghost')).toBeNull();
        });
    });

    describe('status', () => {
        it('updates and reads status', async () => {
            await createTranscription('job-1', 'user-A');
            expect(await getMeetingStatus('job-1')).toBe('in-progress');
            expect(await updateMeetingStatus('job-1', 'completed')).toBe(true);
            expect(await getMeetingStatus('job-1')).toBe('completed');
        });

        it('updateMeetingStatus returns false for a missing meeting', async () => {
            expect(await updateMeetingStatus('ghost', 'completed')).toBe(false);
        });
    });
});
