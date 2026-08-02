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
    listMeetings,
    deleteMeeting,
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

    describe('listMeetings', () => {
        it('returns only the caller\'s meetings, newest first', async () => {
            await createTranscription('job-1', 'user-A');
            await createTranscription('job-2', 'user-B');
            await createTranscription('job-3', 'user-A');

            const mine = await listMeetings('user-A');

            expect(mine.map((m) => m.meetingId).sort()).toEqual(['job-1', 'job-3']);
            expect(mine.every((m) => 'status' in m && 'createdAt' in m)).toBe(true);
        });

        it('carries the summary title when there is one, and null when there is not', async () => {
            await createTranscription('job-1', 'user-A');
            await createTranscription('job-2', 'user-A');
            mem.public.none(
                `INSERT INTO meeting_summaries (job_id, title, content) VALUES ('job-1', 'Q3 pricing', 'x')`
            );

            const byId = Object.fromEntries((await listMeetings('user-A')).map((m) => [m.meetingId, m]));

            expect(byId['job-1'].title).toBe('Q3 pricing');
            expect(byId['job-2'].title).toBeNull();
        });

        it('caps how many it returns', async () => {
            for (let i = 0; i < 5; i++) await createTranscription(`job-${i}`, 'user-A');
            expect(await listMeetings('user-A', { limit: 2 })).toHaveLength(2);
        });

        it('returns an empty list for someone with no meetings', async () => {
            expect(await listMeetings('nobody')).toEqual([]);
        });
    });

    describe('deleteMeeting', () => {
        it('removes the meeting and everything derived from it', async () => {
            await createTranscription('job-1', 'user-A');
            await appendTranscription('job-1', 'some speech');
            mem.public.none(
                `INSERT INTO meeting_summaries (job_id, title, content) VALUES ('job-1', 't', 'c')`
            );

            expect(await deleteMeeting('job-1')).toBe(true);

            expect(await getMeetingOwner('job-1')).toBeNull();
            // FK cascade, so nothing derived is left pointing at a meeting that is gone
            expect(mem.public.many(
                `SELECT count(*)::int AS n FROM meeting_summaries WHERE job_id = 'job-1'`
            )[0].n).toBe(0);
            expect(mem.public.many(
                `SELECT count(*)::int AS n FROM transcription_chunks WHERE job_id = 'job-1'`
            )[0].n).toBe(0);
        });

        it('leaves other meetings alone', async () => {
            await createTranscription('job-1', 'user-A');
            await createTranscription('job-2', 'user-A');

            await deleteMeeting('job-1');

            expect(await getMeetingOwner('job-2')).toBe('user-A');
        });

        it('returns false for a meeting that does not exist', async () => {
            expect(await deleteMeeting('ghost')).toBe(false);
        });
    });
});
