// Meeting sharing persistence against pg-mem, loading the real src/infra/schema.sql.

const { newDb } = require('pg-mem');

const { loadSchema } = require('./helpers/schema');

const schema = loadSchema();

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));
jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { _setPoolForTesting, closePool, query } = require('../src/infra/postgres');
const {
    grantShare, revokeShare, listShares, isSharedWith, listSharedMeetings,
} = require('../src/meetings/meeting.share.repository');

let mem;
beforeEach(async () => {
    mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m1', 'owner-A']);
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m2', 'owner-C']);
});
afterEach(async () => { await closePool(); });

describe('grantShare', () => {
    it('creates a share and reports it as shared', async () => {
        const share = await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        expect(share).toMatchObject({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        expect(share.id).toEqual(expect.any(String));
        expect(await isSharedWith('m1', 'reader-B')).toBe(true);
    });

    it('is idempotent: granting the same account twice does not duplicate the row', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        const { rows } = await query(
            'SELECT * FROM meeting_shares WHERE meeting_id = $1 AND shared_with = $2', ['m1', 'reader-B']);
        expect(rows).toHaveLength(1);
    });

    it('cascades away when the meeting is deleted', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        await query('DELETE FROM meetings WHERE job_id = $1', ['m1']);

        const { rows } = await query('SELECT * FROM meeting_shares WHERE meeting_id = $1', ['m1']);
        expect(rows).toHaveLength(0);
    });
});

describe('isSharedWith', () => {
    it('is false for a meeting never shared with that account', async () => {
        expect(await isSharedWith('m1', 'reader-B')).toBe(false);
    });

    it('does not leak across meetings: a grant on m1 does not cover m2', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        expect(await isSharedWith('m2', 'reader-B')).toBe(false);
    });
});

describe('revokeShare', () => {
    it('ANCHOR: revocation actually revokes', async () => {
        const share = await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        expect(await isSharedWith('m1', 'reader-B')).toBe(true);

        const revoked = await revokeShare('m1', share.id);

        expect(revoked).toBe(true);
        expect(await isSharedWith('m1', 'reader-B')).toBe(false);
    });

    it('returns false for a share id that does not exist', async () => {
        expect(await revokeShare('m1', 'no-such-share')).toBe(false);
    });

    it('will not revoke a share id that belongs to a different meeting', async () => {
        const share = await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        const revoked = await revokeShare('m2', share.id);

        expect(revoked).toBe(false);
        expect(await isSharedWith('m1', 'reader-B')).toBe(true);
    });
});

describe('listShares', () => {
    it('lists everyone a meeting is shared with', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-C', grantedBy: 'owner-A' });

        const shares = await listShares('m1');

        expect(shares).toHaveLength(2);
        expect(shares.map((s) => s.userId).sort()).toEqual(['reader-B', 'reader-C']);
    });

    it('resolves the email for an account that has a local users row', async () => {
        await query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
            ['reader-B', 'reader@example.com', 'hash']);
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        const [share] = await listShares('m1');
        expect(share.email).toBe('reader@example.com');
    });

    it('reports null email for an account with no local users row (e.g. Supabase auth)', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        const [share] = await listShares('m1');
        expect(share.email).toBeNull();
    });

    it('does not leak another meeting\'s shares', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });
        await grantShare({ meetingId: 'm2', sharedWith: 'reader-D', grantedBy: 'owner-C' });

        expect((await listShares('m1')).map((s) => s.userId)).toEqual(['reader-B']);
    });
});

describe('listSharedMeetings', () => {
    it('lists meetings shared with an account, not their own', async () => {
        await grantShare({ meetingId: 'm1', sharedWith: 'reader-B', grantedBy: 'owner-A' });

        const shared = await listSharedMeetings('reader-B');

        expect(shared).toHaveLength(1);
        expect(shared[0].meetingId).toBe('m1');
    });

    it('returns nothing for an account nothing has been shared with', async () => {
        expect(await listSharedMeetings('nobody')).toEqual([]);
    });

    it('does not include a meeting the account owns but was not shared with them', async () => {
        expect(await listSharedMeetings('owner-A')).toEqual([]);
    });
});
