// Drives the gateway over a real HTTP server and real ws client, so the upgrade
// handshake and its rejection paths are exercised rather than mocked.

const http = require('http');
const WebSocket = require('ws');

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { attachGateway } = require('../src/realtime/gateway');

function fakeLane() {
    const lane = {
        sent: [],
        sendAudio(f) { lane.sent.push(f); return true; },
        flush: jest.fn(),
        close: jest.fn(),
        health: () => ({ open: true }),
        emit: null,
    };
    return lane;
}

async function startGateway(over = {}) {
    const lane = fakeLane();
    const onUtterance = jest.fn();
    const server = http.createServer();

    const gw = attachGateway({
        flushGraceMs: 0,
        server,
        verifyAccessToken: async (t) => {
            if (t !== 'good-token') throw new Error('bad token');
            return { sub: 'user-A' };
        },
        getMeetingOwner: async (id) => (id === 'm1' ? 'user-A' : id === 'other' ? 'user-B' : null),
        createLane: ({ onEvent }) => { lane.emit = onEvent; return lane; },
        onUtterance,
        ...over,
    });

    await new Promise((r) => server.listen(0, r));
    return { server, gw, lane, onUtterance, port: server.address().port };
}

function connect(port, qs) {
    return new WebSocket(`ws://127.0.0.1:${port}/rt?${qs}`);
}

// Collect messages until `predicate` is satisfied or the socket closes.
function collect(ws, predicate) {
    return new Promise((resolve, reject) => {
        const msgs = [];
        const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(msgs)}`)), 3000);
        ws.on('message', (raw) => {
            msgs.push(JSON.parse(raw.toString()));
            if (predicate(msgs)) { clearTimeout(timer); resolve(msgs); }
        });
        ws.on('error', () => {});
        ws.on('close', () => { clearTimeout(timer); resolve(msgs); });
    });
}

function audioFrame(seq, bytes = [1, 2]) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq, 0);
    return Buffer.concat([head, Buffer.from(bytes)]);
}

let ctx;
beforeEach(async () => { ctx = await startGateway(); });
afterEach(async () => {
    await ctx.gw.closeAll();
    await new Promise((r) => ctx.server.close(r));
});

describe('upgrade authorization', () => {
    it('accepts an owner with a valid token', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        const msgs = await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));
        expect(msgs[0]).toMatchObject({ type: 'session.ready', meetingId: 'm1' });
        ws.close();
    });

    it('rejects a bad token with 401 before any socket exists', async () => {
        const ws = connect(ctx.port, 'token=nope&meetingId=m1');
        const err = await new Promise((r) => ws.on('error', r));
        expect(err.message).toMatch(/401/);
    });

    it('rejects a missing token', async () => {
        const ws = connect(ctx.port, 'meetingId=m1');
        const err = await new Promise((r) => ws.on('error', r));
        expect(err.message).toMatch(/401/);
    });

    it('returns 404 — not 403 — for a meeting owned by someone else', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=other');
        const err = await new Promise((r) => ws.on('error', r));
        expect(err.message).toMatch(/404/);
        expect(err.message).not.toMatch(/403/);
    });

    it('returns 404 for a meeting that does not exist', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=ghost');
        const err = await new Promise((r) => ws.on('error', r));
        expect(err.message).toMatch(/404/);
    });

    it('rejects a request with no meetingId', async () => {
        const ws = connect(ctx.port, 'token=good-token');
        const err = await new Promise((r) => ws.on('error', r));
        expect(err.message).toMatch(/400/);
    });

    it('ignores upgrades on other paths', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/somewhere?token=good-token`);
        const err = await new Promise((r) => ws.on('error', r));
        expect(err.message).toMatch(/404/);
    });
});

describe('audio and events', () => {
    it('strips the sequence prefix and forwards audio to the lane', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        ws.send(audioFrame(0, [9, 9]));
        await new Promise((r) => setTimeout(r, 50));

        expect(ctx.lane.sent).toHaveLength(1);
        expect(ctx.lane.sent[0]).toEqual(Buffer.from([9, 9]));
        ws.close();
    });

    it('relays transcripts and emits a watermark after each final', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.lane.emit({ lane: 'words', kind: 'partial', text: 'he', t0Ms: 0, t1Ms: 200 });
        ctx.lane.emit({ lane: 'words', kind: 'final', text: 'hello', t0Ms: 0, t1Ms: 900, turnId: 1 });

        const msgs = await got;
        expect(msgs.find((m) => m.type === 'partial')).toMatchObject({ text: 'he' });
        expect(msgs.find((m) => m.type === 'final')).toMatchObject({ text: 'hello', speaker: null });
        expect(msgs.find((m) => m.type === 'watermark')).toMatchObject({ watermarkMs: 900 });
        ws.close();
    });

    it('persists finals but not partials', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.lane.emit({ lane: 'words', kind: 'partial', text: 'he', t0Ms: 0, t1Ms: 200 });
        ctx.lane.emit({ lane: 'words', kind: 'final', text: 'hello', t0Ms: 0, t1Ms: 900 });
        await got;

        expect(ctx.onUtterance).toHaveBeenCalledTimes(1);
        expect(ctx.onUtterance).toHaveBeenCalledWith('m1', expect.objectContaining({ text: 'hello' }));
        ws.close();
    });

    it('reports speaker as null rather than omitting it', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'final'));
        ctx.lane.emit({ lane: 'words', kind: 'final', text: 'x', t0Ms: 0, t1Ms: 10 });
        const final = (await got).find((m) => m.type === 'final');

        expect(final).toHaveProperty('speaker', null);
        expect(final.confidence).toBe('unknown');
        ws.close();
    });

    it('keeps the session alive when persistence throws', async () => {
        await ctx.gw.closeAll();
        await new Promise((r) => ctx.server.close(r));
        ctx = await startGateway({ onUtterance: () => Promise.reject(new Error('db down')) });

        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'watermark'));
        ctx.lane.emit({ lane: 'words', kind: 'final', text: 'still here', t0Ms: 0, t1Ms: 100 });
        const msgs = await got;

        expect(msgs.find((m) => m.type === 'final')).toMatchObject({ text: 'still here' });
        ws.close();
    });

    it('answers a malformed control message without dropping the session', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'error'));
        ws.send('this is not json');
        const msgs = await got;

        expect(msgs.find((m) => m.type === 'error')).toMatchObject({ code: 'bad_message', fatal: false });
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });

    it('ignores a truncated audio frame', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        ws.send(Buffer.from([1, 2]));            // shorter than the 4-byte header
        await new Promise((r) => setTimeout(r, 50));

        expect(ctx.lane.sent).toHaveLength(0);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });
});

describe('lifecycle', () => {
    it('tears the session down when the client disconnects', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));
        expect(ctx.gw.sessionCount()).toBe(1);

        ws.close();
        await new Promise((r) => setTimeout(r, 100));

        expect(ctx.gw.sessionCount()).toBe(0);
        expect(ctx.lane.close).toHaveBeenCalled();
    });

    it('closes the lane when the client sends stop', async () => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        ws.send(JSON.stringify({ event: 'stop' }));
        await new Promise((r) => setTimeout(r, 100));

        expect(ctx.lane.flush).toHaveBeenCalled();
        expect(ctx.lane.close).toHaveBeenCalled();
        ws.close();
    });

    // JSON.parse succeeds on these and returns a non-object, so reading .event off the result
    // throws inside the message handler. Nothing catches that: there is no uncaughtException
    // handler anywhere in src, so one frame from one authenticated client ends the process for
    // every other meeting on the box.
    it.each(['null', 'true', '42', '"a string"'])('survives the text frame %s', async (frame) => {
        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        ws.send(frame);
        await new Promise((r) => setTimeout(r, 100));

        // Still serving: the session is open and a real stop still works.
        expect(ctx.gw.sessionCount()).toBe(1);
        ws.send(JSON.stringify({ event: 'stop' }));
        await new Promise((r) => setTimeout(r, 100));
        expect(ctx.lane.close).toHaveBeenCalled();
        ws.close();
    });

    it('signals the end of the meeting once, however it ends', async () => {
        await ctx.gw.closeAll();
        await new Promise((r) => ctx.server.close(r));

        const onSessionEnd = jest.fn();
        ctx = await startGateway({ onSessionEnd });

        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        // stop, then disconnect, then shutdown (all three reach the same hook)
        ws.send(JSON.stringify({ event: 'stop' }));
        await new Promise((r) => setTimeout(r, 100));
        ws.close();
        await new Promise((r) => setTimeout(r, 100));
        await ctx.gw.closeAll();

        expect(onSessionEnd).toHaveBeenCalledTimes(1);
        expect(onSessionEnd).toHaveBeenCalledWith('m1');
    });

    it('runs the end hook when the server shuts down mid-meeting', async () => {
        await ctx.gw.closeAll();
        await new Promise((r) => ctx.server.close(r));

        const onSessionEnd = jest.fn();
        ctx = await startGateway({ onSessionEnd });

        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        await ctx.gw.closeAll();
        expect(onSessionEnd).toHaveBeenCalledWith('m1');
        ws.close();
    });

    it('does not let a failing end hook break shutdown', async () => {
        await ctx.gw.closeAll();
        await new Promise((r) => ctx.server.close(r));

        ctx = await startGateway({
            onSessionEnd: async () => { throw new Error('embed service down'); },
        });

        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        await expect(ctx.gw.closeAll()).resolves.toBeUndefined();
        ws.close();
    });

    it('closes the socket when the lane cannot be built', async () => {
        await ctx.gw.closeAll();
        await new Promise((r) => ctx.server.close(r));
        ctx = await startGateway({
            createLane: () => { throw new Error('no api key'); },
        });

        const ws = connect(ctx.port, 'token=good-token&meetingId=m1');
        const msgs = await collect(ws, (m) => m.some((x) => x.type === 'error'));
        expect(msgs.find((m) => m.type === 'error')).toMatchObject({
            code: 'lane_unavailable', fatal: true,
        });
    });
});

describe('fusion integration', () => {
    async function startWithSpeaker(over = {}) {
        const words = fakeLane();
        const speaker = fakeLane();
        const onRevision = jest.fn();
        const server = http.createServer();
        const gw = attachGateway({
        flushGraceMs: 0,
            server,
            verifyAccessToken: async () => ({ sub: 'user-A' }),
            getMeetingOwner: async () => 'user-A',
            createLane: ({ onEvent }) => { words.emit = onEvent; return words; },
            createSpeakerLane: ({ onEvent }) => { speaker.emit = onEvent; return speaker; },
            onRevision,
            ...over,
        });
        await new Promise((r) => server.listen(0, r));
        return { server, gw, words, speaker, onRevision, port: server.address().port };
    }

    it('attributes a final when the speaker interval arrived first', async () => {
        const c = await startWithSpeaker();
        const ws = connect(c.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'final'));
        c.speaker.emit({ lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 5000, speakerLabel: 'S1', confidence: 'confident' });
        c.words.emit({ lane: 'words', kind: 'final', text: 'hello', t0Ms: 0, t1Ms: 900, turnId: 1 });

        const final = (await got).find((m) => m.type === 'final');
        expect(final).toMatchObject({ speaker: 'S1', confidence: 'confident' });

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });

    it('emits a revision when the speaker arrives after the text', async () => {
        const c = await startWithSpeaker();
        const ws = connect(c.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'revision'));
        c.words.emit({ lane: 'words', kind: 'final', text: 'hello', t0Ms: 0, t1Ms: 900, turnId: 1 });
        c.speaker.emit({ lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 5000, speakerLabel: 'S2', confidence: 'confident' });

        const msgs = await got;
        expect(msgs.find((m) => m.type === 'final')).toMatchObject({ speaker: null });
        expect(msgs.find((m) => m.type === 'revision')).toMatchObject({ turnId: 1, speaker: 'S2' });
        expect(c.onRevision).toHaveBeenCalledWith('m1', expect.objectContaining({ speakerLabel: 'S2' }));

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });

    it('never attributes a partial even when speaker data exists', async () => {
        const c = await startWithSpeaker();
        const ws = connect(c.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'partial'));
        c.speaker.emit({ lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 5000, speakerLabel: 'S1' });
        c.words.emit({ lane: 'words', kind: 'partial', text: 'hel', t0Ms: 0, t1Ms: 300 });

        expect((await got).find((m) => m.type === 'partial')).toMatchObject({ speaker: null });

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });

    it('runs unattributed when the speaker lane cannot start', async () => {
        const c = await startWithSpeaker({ createSpeakerLane: () => { throw new Error('svc down'); } });
        const ws = connect(c.port, 'token=good-token&meetingId=m1');
        const msgs = await collect(ws, (m) => m.some((x) => x.type === 'lane.status'));

        expect(msgs.find((m) => m.type === 'lane.status')).toMatchObject({ lane: 'speaker', status: 'down' });
        expect(msgs.some((m) => m.type === 'error')).toBe(false);

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });
});

// A dropped socket ends the session. The client reconnects with its sequence back at 0, so the
// gateway has to shift lane timestamps past what is already stored — otherwise the resumed meeting
// overwrites its own timeline from the beginning.
describe('resuming a meeting', () => {
    it('shifts timestamps past what is already stored', async () => {
        const c = await startGateway({ getWatermarkMs: async () => 600000 });
        const ws = connect(c.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'final'));
        c.lane.emit({ lane: 'words', kind: 'final', text: 'resumed', t0Ms: 0, t1Ms: 900 });
        const msgs = await got;

        expect(msgs.find((m) => m.type === 'final')).toMatchObject({ t0: 600000, t1: 600900 });

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });

    it('leaves a fresh meeting starting at zero', async () => {
        const c = await startGateway({ getWatermarkMs: async () => 0 });
        const ws = connect(c.port, 'token=good-token&meetingId=m1');
        await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));

        const got = collect(ws, (m) => m.some((x) => x.type === 'final'));
        c.lane.emit({ lane: 'words', kind: 'final', text: 'first', t0Ms: 0, t1Ms: 900 });
        const msgs = await got;

        expect(msgs.find((m) => m.type === 'final')).toMatchObject({ t0: 0 });

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });

    // Losing the watermark must not stop the meeting; it only costs correct resume timing.
    it('still connects when the watermark cannot be read', async () => {
        const c = await startGateway({ getWatermarkMs: async () => { throw new Error('db down'); } });
        const ws = connect(c.port, 'token=good-token&meetingId=m1');

        const msgs = await collect(ws, (m) => m.some((x) => x.type === 'session.ready'));
        expect(msgs.some((m) => m.type === 'session.ready')).toBe(true);

        ws.close(); await c.gw.closeAll(); await new Promise((r) => c.server.close(r));
    });
});
