// tests/chat.db.test.js
// Exercises the Postgres chat DB layer against pg-mem, loading the actual src/infra/schema.sql
// so the queries are validated end-to-end (no live DB required).

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const { loadSchema } = require('./helpers/schema');

const schema = loadSchema();
let mem;

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));

const { _setPoolForTesting, closePool } = require('../src/infra/postgres');
const { createChatEntry, updateChatEntry, getChatHistory } = require('../src/chat/chat.repository');

beforeEach(() => {
    mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
});

afterEach(async () => { await closePool(); });

// Helper: insert a parent meeting so FK constraints are satisfied.
async function insertMeeting(jobId = 'job-1') {
    const { query } = require('../src/infra/postgres');
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', [jobId, 'user-A']);
}

// Helper: insert a chat row with an explicit created_at to control ordering in tests.
async function insertChatDirect(id, jobId, userChat, createdAt) {
    const { query } = require('../src/infra/postgres');
    await query(
        'INSERT INTO chats (id, job_id, user_chat, created_at) VALUES ($1, $2, $3, $4)',
        [id, jobId, userChat, createdAt]
    );
}

describe('chat.db (Postgres)', () => {
    describe('createChatEntry', () => {
        it('returns an object with _id and all expected fields', async () => {
            await insertMeeting('job-1');
            const chat = await createChatEntry('job-1', 'Hello?');

            expect(chat).toHaveProperty('_id');
            expect(typeof chat._id).toBe('string');
            expect(chat._id).toBe(chat.id);
            expect(chat.jobId).toBe('job-1');
            expect(chat.userChat).toBe('Hello?');
            expect(chat.aiChat).toBeNull();
            expect(chat.createdAt).toBeDefined();
        });

        it('throws on FK violation (no parent meeting)', async () => {
            await expect(createChatEntry('ghost-job', 'Hi')).rejects.toThrow();
        });
    });

    describe('updateChatEntry', () => {
        it('sets ai_chat and returns the updated row', async () => {
            await insertMeeting('job-1');
            const created = await createChatEntry('job-1', 'Tell me more');

            const updated = await updateChatEntry(created._id, 'Here is the answer');
            expect(updated._id).toBe(created._id);
            expect(updated.aiChat).toBe('Here is the answer');
            expect(updated.userChat).toBe('Tell me more');
        });

        it('throws when the chatId does not exist', async () => {
            await expect(updateChatEntry('nonexistent-id', 'response')).rejects.toThrow(
                'Chat document not found for update.'
            );
        });
    });

    describe('getChatHistory', () => {
        it('returns chats in ascending created_at order (chronological)', async () => {
            await insertMeeting('job-1');
            // Insert with explicit, distinct timestamps to avoid tie-breaking issues.
            await insertChatDirect('id-1', 'job-1', 'first',  '2024-01-01T10:00:00Z');
            await insertChatDirect('id-2', 'job-1', 'second', '2024-01-01T10:01:00Z');
            await insertChatDirect('id-3', 'job-1', 'third',  '2024-01-01T10:02:00Z');

            const history = await getChatHistory('job-1', 10);
            expect(history.map(c => c.userChat)).toEqual(['first', 'second', 'third']);
        });

        it('respects the limit (returns only the most recent N, in ascending order)', async () => {
            await insertMeeting('job-1');
            await insertChatDirect('id-1', 'job-1', 'first',  '2024-01-01T10:00:00Z');
            await insertChatDirect('id-2', 'job-1', 'second', '2024-01-01T10:01:00Z');
            await insertChatDirect('id-3', 'job-1', 'third',  '2024-01-01T10:02:00Z');

            // Limit 2 should return the 2 most recent in ascending order.
            const history = await getChatHistory('job-1', 2);
            expect(history.map(c => c.userChat)).toEqual(['second', 'third']);
        });

        it('returns an empty array when there are no chats for the job', async () => {
            await insertMeeting('job-1');
            const history = await getChatHistory('job-1', 5);
            expect(history).toEqual([]);
        });

        it('maps rows to camelCase and includes _id', async () => {
            await insertMeeting('job-1');
            await insertChatDirect('id-x', 'job-1', 'hello', '2024-01-01T10:00:00Z');

            const [chat] = await getChatHistory('job-1', 5);
            expect(chat._id).toBe('id-x');
            expect(chat.id).toBe('id-x');
            expect(chat.jobId).toBe('job-1');
            expect(chat.userChat).toBe('hello');
            expect(chat.aiChat).toBeNull();
        });

        it('filters by beforeChatId (only returns chats before that timestamp)', async () => {
            await insertMeeting('job-1');
            await insertChatDirect('id-1', 'job-1', 'first',  '2024-01-01T10:00:00Z');
            await insertChatDirect('id-2', 'job-1', 'second', '2024-01-01T10:01:00Z');
            await insertChatDirect('id-3', 'job-1', 'third',  '2024-01-01T10:02:00Z');

            // Using id-3 as the cursor, we expect only first and second.
            const history = await getChatHistory('job-1', 10, 'id-3');
            expect(history.map(c => c.userChat)).toEqual(['first', 'second']);
        });
    });
});
