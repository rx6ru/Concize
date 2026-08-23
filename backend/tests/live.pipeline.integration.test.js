// End to end: websocket -> gateway -> session -> fusion -> utterance log (pg-mem) -> chunks.
// Covers the seams between modules, where the wiring bugs have tended to live.

const http = require('http');
const fs = require('fs');
const path = require('path');
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
const { appendUtterance, reviseUtterance, getTranscript } = require('../src/transcript/utterance.repository');
const { insertChunk, getChunks, markDirtyForRange, getDirtyChunks } = require('../src/transcript/chunk.repository');
const { createDeriveService } = require('../src/transcript/derive.service');

function fakeLane() {
    const lane = {
        frames: [],
        sendAudio(f) { lane.frames.push(f); return true; },
        flush: jest.fn(), close: jest.fn(), health: () => ({ open: true }), emit: null,
    };
    return lane;
}

function collect(ws, predicate, ms = 3000) {
    return new Promise((resolve, reject) => {
        const msgs = [];
        const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(msgs)}`)), ms);
        ws.on('message', (raw) => {
            msgs.push(JSON.parse(raw.toString()));
            if (predicate(msgs)) { clearTimeout(timer); resolve(msgs); }
        });
        ws.on('close', () => { clearTimeout(timer); resolve(msgs); });
        ws.on('error', () => {});
    });
}

// Persistence finishes after the socket message announcing it, so this polls instead of a
// fixed sleep. A fixed wait passes locally but flakes under load.
async function until(fn, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('condition never held');
        await new Promise((r) => setTimeout(r, 10));
    }
}

function audioFrame(seq) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq, 0);
    return Buffer.concat([head, Buffer.alloc(3200)]);
}

let ctx;

beforeEach(async () => {
    const mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m1', 'user-A']);

    const words = fakeLane();
    const speaker = fakeLane();

    // Chunk quickly so a short test still exercises the derive path.
    const derive = createDeriveService({
        insertChunk, markDirtyForRange,
        chunkerOptions: { maxDurationMs: 4000, minDurationMs: 500, overlapRatio: 0 },
    });

    const server = http.createServer();
    const gw = attachGateway({
        flushGraceMs: 0,
        server,
        verifyAccessToken: async () => ({ sub: 'user-A' }),
        getMeetingOwner: async (id) => (id === 'm1' ? 'user-A' : null),
        createLane: ({ onEvent }) => { words.emit = onEvent; return words; },
        createSpeakerLane: ({ onEvent }) => { speaker.emit = onEvent; return speaker; },
        onUtterance: async (meetingId, u) => {
            await appendUtterance(meetingId, { ...u, turnId: String(u.turnId) });
            await derive.ingest(meetingId, { ...u, turnId: String(u.turnId) });
        },
        onRevision: async (meetingId, u) => {
            await reviseUtterance(meetingId, String(u.turnId), u);
            await derive.onUtteranceRevised(meetingId, u);
        },
    });

    await new Promise((r) => server.listen(0, r));
    ctx = { server, gw, words, speaker, derive, port: server.address().port };
});

afterEach(async () => {
    await ctx.gw.closeAll();
    await new Promise((r) => ctx.server.close(r));
    await closePool();
});

const connect = () => new WebSocket(`ws://127.0.0.1:${ctx.port}/rt?token=t&meetingId=m1`);

describe('live pipeline', () => {
    it('carries audio to the lane and text back to the client', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        ws.send(audioFrame(0));
        await until(() => ctx.words.frames.length === 1);
        expect(ctx.speaker.frames).toHaveLength(1);   // one ingress, fanned out

        const got = collect(ws, (m) => m.some((x) => x.type === 'final'));
        ctx.words.emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'hello there' });
        const final = (await got).find((m) => m.type === 'final');

        expect(final).toMatchObject({ text: 'hello there', speaker: null });
        ws.close();
    });

    it('persists a finalised utterance to the transcript log', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.words.emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'persisted' });
        await got;

        const transcript = await until(async () => {
            const t = await getTranscript('m1');
            return t.length === 1 ? t : null;
        });
        expect(transcript[0]).toMatchObject({ text: 'persisted', speakerLabel: null });
        ws.close();
    });

    it('attributes the utterance when the speaker lane reports first', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.speaker.emit({
            lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 5000,
            speakerLabel: 'S1', confidence: 'confident',
        });
        ctx.words.emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'attributed' });
        await got;

        const [row] = await until(async () => {
            const t = await getTranscript('m1');
            return t.length === 1 ? t : null;
        });
        expect(row).toMatchObject({ speakerLabel: 'S1', speakerConfidence: 'confident' });
        ws.close();
    });

    it('revises the stored row when the speaker arrives late', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const gotFinal = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.words.emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'late speaker' });
        await gotFinal;
        const [stored] = await until(async () => {
            const t = await getTranscript('m1');
            return t.length === 1 ? t : null;
        });
        expect(stored.speakerLabel).toBeNull();

        const gotRevision = collect(ws, (m) => m.some((x) => x.type === 'revision'));
        ctx.speaker.emit({
            lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 5000,
            speakerLabel: 'S2', confidence: 'confident',
        });
        await gotRevision;

        const transcript = await until(async () => {
            const t = await getTranscript('m1');
            return t[0]?.rev === 1 ? t : null;
        });
        expect(transcript).toHaveLength(1);                       // still one current row
        expect(transcript[0]).toMatchObject({ rev: 1, speakerLabel: 'S2' });
        ws.close();
    });

    it('derives and stores a chunk once a boundary is reached', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        // one collect per emission: each call sees only messages from its own registration
        for (const [turnId, t0] of [[1, 0], [2, 1000], [3, 2000]]) {
            const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
            ctx.words.emit({
                lane: 'words', kind: 'final', turnId,
                t0Ms: t0, t1Ms: t0 + 900, text: `line ${turnId}`,
            });
            await got;
        }
        // push past the 4s cap
        const last = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.words.emit({ lane: 'words', kind: 'final', turnId: 4, t0Ms: 3000, t1Ms: 6000, text: 'closing' });
        await last;

        const chunks = await until(async () => {
            const c = await getChunks('m1');
            return c.length >= 1 ? c : null;
        });
        expect(chunks[0].text).toContain('line 1');
        ws.close();
    });

    it('marks derived chunks dirty when an utterance is corrected', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        // build a chunk covering 0–6000
        for (const [turnId, t0] of [[1, 0], [2, 1000], [3, 2000], [4, 3000]]) {
            const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
            ctx.words.emit({
                lane: 'words', kind: 'final', turnId,
                t0Ms: t0, t1Ms: t0 + (turnId === 4 ? 3000 : 900), text: `line ${turnId}`,
            });
            await got;
        }
        await until(async () => (await getChunks('m1')).length >= 1);

        const gotRevision = collect(ws, (m) => m.some((x) => x.type === 'revision'));
        ctx.speaker.emit({
            lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 1000,
            speakerLabel: 'S9', confidence: 'confident',
        });
        await gotRevision;
        await until(async () => (await getDirtyChunks('m1')).length >= 1);
        ws.close();
    });

    it('keeps transcribing when the speaker service dies mid-meeting', async () => {
        const ws = connect();
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        ctx.speaker.sendAudio = () => { throw new Error('speaker svc gone'); };
        ws.send(audioFrame(0));
        await until(() => ctx.words.frames.length === 1);

        const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.words.emit({ lane: 'words', kind: 'final', turnId: 1, t0Ms: 0, t1Ms: 900, text: 'still working' });
        await got;

        const [row] = await until(async () => {
            const t = await getTranscript('m1');
            return t.length === 1 ? t : null;
        });
        expect(row.text).toBe('still working');
        ws.close();
    });
});
