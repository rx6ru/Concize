const { EventEmitter } = require('events');

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createFunasrSpeakerLane, normalise } = require('../src/providers/speaker/funasr.lane');

class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }
    serverSays(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
    binary() { return this.sent.filter((s) => Buffer.isBuffer(s)); }
    control(ev) { return this.sent.filter((s) => typeof s === 'string' && JSON.parse(s).event === ev); }
}

function makeLane(over = {}) {
    const sockets = [];
    const onEvent = jest.fn();
    const onError = jest.fn();
    const onClose = jest.fn();
    const lane = createFunasrSpeakerLane({
        sessionId: 's1', onEvent, onError, onClose, reconnect: false,
        wsFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
        ...over,
    });
    if (over.autoOpen !== false) sockets[0].emit('open');
    return { lane, sockets, socket: sockets[0], onEvent, onError, onClose };
}

describe('connection', () => {
    it('passes session and sample rate to the service', () => {
        let url;
        createFunasrSpeakerLane({
            sessionId: 'abc', sampleRate: 8000, onEvent: jest.fn(), reconnect: false,
            wsFactory: (u) => { url = u; return new FakeSocket(); },
        });
        expect(url).toContain('session=abc');
        expect(url).toContain('sample_rate=8000');
    });

    it('sends raw PCM as binary, not base64', () => {
        const { lane, socket } = makeLane();
        const frame = Buffer.from([1, 2, 3, 4]);
        expect(lane.sendAudio(frame)).toBe(true);
        expect(socket.binary()).toEqual([frame]);
    });

    it('requires an onEvent callback', () => {
        expect(() => createFunasrSpeakerLane({ sessionId: 's' })).toThrow(/onEvent is required/);
    });
});

describe('speaker intervals', () => {
    it('normalises a speaker interval', () => {
        const { socket, onEvent } = makeLane();
        socket.serverSays({ event: 'speaker', t0_ms: 0, t1_ms: 1500, speaker: 0, confidence: 'confident' });

        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
            lane: 'speaker', kind: 'interval', t0Ms: 0, t1Ms: 1500,
            speakerLabel: 'S0', confidence: 'confident',
        }));
    });

    it('prefixes the numeric id so it reads as a speaker and not a number', () => {
        expect(normalise({ event: 'speaker', t0_ms: 0, t1_ms: 1, speaker: 3 }).speakerLabel).toBe('S3');
    });

    it('keeps a null speaker null rather than turning it into "null"', () => {
        expect(normalise({ event: 'speaker', t0_ms: 0, t1_ms: 1, speaker: null }).speakerLabel).toBeNull();
    });

    it('defaults missing confidence to unknown', () => {
        expect(normalise({ event: 'speaker', t0_ms: 0, t1_ms: 1, speaker: '1' }).confidence).toBe('unknown');
    });

    it('ignores non-speaker frames', () => {
        const { socket, onEvent } = makeLane();
        socket.serverSays({ event: 'ready' });
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('survives a non-JSON frame', () => {
        const { socket, onEvent, onError } = makeLane();
        expect(() => socket.emit('message', Buffer.from('<html>'))).not.toThrow();
        expect(onEvent).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it('surfaces a service error with its fatal flag', () => {
        const { socket, onError } = makeLane();
        socket.serverSays({ event: 'error', message: 'model not loaded', fatal: true });
        expect(onError).toHaveBeenCalledWith(expect.any(Error), { fatal: true });
    });
});

describe('degradation', () => {
    it('drops audio while disconnected instead of queueing stale frames', () => {
        const { lane, socket } = makeLane();
        socket.readyState = 3;                     // service went away
        expect(lane.sendAudio(Buffer.from([1]))).toBe(false);
        expect(lane.health().framesDropped).toBe(1);
        expect(socket.binary()).toHaveLength(0);
    });

    it('reconnects after an unexpected close', () => {
        jest.useFakeTimers();
        const sockets = [];
        createFunasrSpeakerLane({
            sessionId: 's1', onEvent: jest.fn(),
            wsFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
        });
        sockets[0].emit('open');
        sockets[0].close();

        jest.advanceTimersByTime(600);
        expect(sockets).toHaveLength(2);
        jest.useRealTimers();
    });

    it('does not reconnect after an intentional close', () => {
        jest.useFakeTimers();
        const sockets = [];
        const lane = createFunasrSpeakerLane({
            sessionId: 's1', onEvent: jest.fn(),
            wsFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
        });
        sockets[0].emit('open');
        lane.close();
        sockets[0].close();

        jest.advanceTimersByTime(30000);
        expect(sockets).toHaveLength(1);
        jest.useRealTimers();
    });

    it('backs off exponentially between attempts', () => {
        jest.useFakeTimers();
        const sockets = [];
        createFunasrSpeakerLane({
            sessionId: 's1', onEvent: jest.fn(),
            wsFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
        });
        sockets[0].emit('open');

        sockets[0].close();
        jest.advanceTimersByTime(500);
        expect(sockets).toHaveLength(2);

        sockets[1].close();
        jest.advanceTimersByTime(500);            // second wait is 1000ms, not 500
        expect(sockets).toHaveLength(2);
        jest.advanceTimersByTime(500);
        expect(sockets).toHaveLength(3);
        jest.useRealTimers();
    });
});

describe('lifecycle', () => {
    it('sends end on close', () => {
        const { lane, socket } = makeLane();
        lane.close();
        expect(socket.control('end')).toHaveLength(1);
    });

    it('refuses audio after close', () => {
        const { lane } = makeLane();
        lane.close();
        expect(lane.sendAudio(Buffer.from([1]))).toBe(false);
    });

    it('is idempotent on close', () => {
        const { lane, socket } = makeLane();
        lane.close();
        lane.close();
        expect(socket.control('end')).toHaveLength(1);
    });

    it('reports health counters', () => {
        const { lane, socket } = makeLane();
        lane.sendAudio(Buffer.from([1]));
        socket.serverSays({ event: 'speaker', t0_ms: 0, t1_ms: 100, speaker: '1' });

        expect(lane.health()).toMatchObject({
            lane: 'speaker', open: true, framesSent: 1, intervals: 1,
        });
    });
});

describe('audio held during connect', () => {
    it('buffers frames sent before the socket opens instead of dropping them', async () => {
        const { lane, socket } = makeLane({ autoOpen: false });

        lane.sendAudio(Buffer.from([1, 2]));
        lane.sendAudio(Buffer.from([3, 4]));
        expect(socket.sent).toHaveLength(0);
        expect(lane.health().framesBuffered).toBe(2);

        socket.emit('open');
        expect(socket.sent).toHaveLength(2);
        expect(lane.health().framesSent).toBe(2);
    });

    it('keeps the held audio in order', () => {
        const { lane, socket } = makeLane({ autoOpen: false });
        lane.sendAudio(Buffer.from([1]));
        lane.sendAudio(Buffer.from([2]));
        socket.emit('open');

        expect(socket.sent.map((b) => b[0])).toEqual([1, 2]);
    });

    it('stops buffering rather than growing without bound when the service never comes up', () => {
        const { lane, socket } = makeLane({ autoOpen: false });
        for (let i = 0; i < 150; i++) lane.sendAudio(Buffer.from([1]));

        expect(lane.health().framesBuffered).toBe(100);
        expect(lane.health().framesDropped).toBe(50);
        socket.emit('open');
        expect(socket.sent).toHaveLength(100);
    });

    it('drops rather than buffers on a reconnect, so stale audio is not replayed', () => {
        const { lane, socket } = makeLane();
        lane.sendAudio(Buffer.from([1]));
        expect(socket.sent).toHaveLength(1);

        socket.readyState = 3;
        socket.emit('close', 1006, Buffer.from(''));
        lane.sendAudio(Buffer.from([2]));

        expect(lane.health().framesDropped).toBe(1);
        expect(lane.health().framesBuffered).toBe(0);
    });
});
