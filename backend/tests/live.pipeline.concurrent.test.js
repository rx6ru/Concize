// Two users recording at the same time. Nothing else in the suite drives more than one meeting
// through the live path at once, so session isolation under concurrency was never exercised: a
// lane, a socket or a persistence call keyed on the wrong meeting would pass every other test.

const http = require('http');
const WebSocket = require('ws');
const { newDb } = require('pg-mem');

const { loadSchema } = require('./helpers/schema');

const schema = loadSchema();

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));
jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { _setPoolForTesting, closePool, query } = require('../src/infra/postgres');
const { attachGateway } = require('../src/realtime/gateway');
const { appendUtterance, getTranscript } = require('../src/transcript/utterance.repository');

// One per session, so a frame delivered to the wrong lane is visible rather than absorbed.
function fakeLane(meetingId, registry) {
    const lane = {
        meetingId,
        frames: [],
        sendAudio(f) { lane.frames.push(f); return true; },
        flush: jest.fn(), close: jest.fn(), health: () => ({ open: true }), emit: null,
    };
    registry.set(meetingId, lane);
    return lane;
}

function audioFrame(seq) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq, 0);
    return Buffer.concat([head, Buffer.alloc(3200)]);
}

function ready(ws) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never became ready')), 3000);
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'session.ready') { clearTimeout(timer); resolve(msg); }
        });
        ws.on('error', reject);
    });
}

async function until(fn, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('condition never held');
        await new Promise((r) => setTimeout(r, 10));
    }
}

let ctx;

beforeEach(async () => {
    const mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());

    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m1', 'user-A']);
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m2', 'user-B']);

    const lanes = new Map();
    const owners = { m1: 'user-A', m2: 'user-B' };

    const server = http.createServer();
    const gw = attachGateway({
        flushGraceMs: 0,
        server,
        // The token names the caller, so each socket authenticates as its own user.
        verifyAccessToken: async (token) => ({ sub: token === 'tokA' ? 'user-A' : 'user-B' }),
        getMeetingOwner: async (id) => owners[id] || null,
        createLane: ({ sessionId, onEvent }) => {
            const lane = fakeLane(sessionId, lanes);
            lane.emit = onEvent;
            return lane;
        },
        onUtterance: async (meetingId, u) => {
            await appendUtterance(meetingId, { ...u, turnId: String(u.turnId) });
        },
    });

    await new Promise((r) => server.listen(0, r));
    ctx = { server, gw, lanes, port: server.address().port };
});

afterEach(async () => {
    await ctx.gw.closeAll();
    await new Promise((r) => ctx.server.close(r));
    await closePool();
});

const connect = (meetingId, token) =>
    new WebSocket(`ws://127.0.0.1:${ctx.port}/rt?token=${token}&meetingId=${meetingId}`);

describe('two meetings recording at once', () => {
    it('keeps each socket audio on its own lane', async () => {
        const a = connect('m1', 'tokA');
        const b = connect('m2', 'tokB');
        await Promise.all([ready(a), ready(b)]);

        a.send(audioFrame(0));
        a.send(audioFrame(1));
        b.send(audioFrame(0));

        await until(async () => ctx.lanes.get('m1').frames.length === 2 && ctx.lanes.get('m2').frames.length === 1);

        expect(ctx.lanes.get('m1').frames).toHaveLength(2);
        expect(ctx.lanes.get('m2').frames).toHaveLength(1);

        a.close();
        b.close();
    });

    it('persists each meeting only its own utterances', async () => {
        const a = connect('m1', 'tokA');
        const b = connect('m2', 'tokB');
        await Promise.all([ready(a), ready(b)]);

        // Interleaved, not sequential: a shared cursor or a mis-keyed write shows up here.
        ctx.lanes.get('m1').emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'alpha one' });
        ctx.lanes.get('m2').emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'bravo one' });
        ctx.lanes.get('m1').emit({ lane: 'words', kind: 'final', turnId: 2, t0Ms: 1000, t1Ms: 1900, text: 'alpha two' });

        const m1 = await until(async () => {
            const rows = await getTranscript('m1');
            return rows.length === 2 ? rows : null;
        });
        const m2 = await until(async () => {
            const rows = await getTranscript('m2');
            return rows.length === 1 ? rows : null;
        });

        expect(m1.map((r) => r.text)).toEqual(['alpha one', 'alpha two']);
        expect(m2.map((r) => r.text)).toEqual(['bravo one']);

        a.close();
        b.close();
    });

    it('refuses a socket for a meeting the caller does not own, while the owner keeps recording', async () => {
        const a = connect('m1', 'tokA');
        await ready(a);

        // user-B reaching for user-A's meeting.
        const intruder = connect('m1', 'tokB');
        const closed = await new Promise((resolve) => {
            intruder.on('close', (code) => resolve(code));
            intruder.on('error', () => {});
        });
        expect(closed).not.toBe(1000);

        // A's session is untouched by the rejection.
        ctx.lanes.get('m1').emit({ lane: 'words', kind: 'final', turnId: 9, t0Ms: 0, t1Ms: 900, text: 'still here' });
        const rows = await until(async () => {
            const r = await getTranscript('m1');
            return r.length === 1 ? r : null;
        });
        expect(rows[0].text).toBe('still here');

        a.close();
    });
});
