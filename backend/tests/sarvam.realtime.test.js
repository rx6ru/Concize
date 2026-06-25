const { EventEmitter } = require('events');

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/core/config', () => ({
    inference: { sarvamKeys: ['test-key'] },
}));

const { createSarvamRealtimeLane, normalise, MODEL } = require('../src/providers/stt/sarvam.realtime');

// Minimal stand-in for the ws client: records sends, lets tests drive server frames.
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1; // OPEN
        this.sent = [];
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }
    serverSays(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
    parsed(event) { return this.sent.filter((m) => m.event === event); }
}

function makeLane(overrides = {}) {
    const socket = new FakeSocket();
    const onEvent = jest.fn();
    const onError = jest.fn();
    const onClose = jest.fn();
    const lane = createSarvamRealtimeLane({
        sessionId: 's1',
        onEvent, onError, onClose,
        wsFactory: () => socket,
        ...overrides,
    });
    socket.emit('open');
    return { lane, socket, onEvent, onError, onClose };
}

describe('sarvam realtime lane', () => {
    it('connects with the only model the realtime endpoint accepts', () => {
        let seenUrl;
        makeLane({ wsFactory: (url) => { seenUrl = url; return new FakeSocket(); } });
        expect(seenUrl).toContain(`model=${encodeURIComponent(MODEL)}`);
        expect(seenUrl).toContain('encoding=linear16');
        expect(seenUrl).toContain('sample_rate=16000');
    });

    it('sends audio as base64 under the audio_input event', () => {
        const { lane, socket } = makeLane();
        lane.sendAudio(Buffer.from([0x01, 0x02, 0x03, 0x04]));
        const frames = socket.parsed('audio_input');
        expect(frames).toHaveLength(1);
        expect(Buffer.from(frames[0].audio, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it('buffers audio sent before the socket opens, then flushes it in order', () => {
        const socket = new FakeSocket();
        const lane = createSarvamRealtimeLane({
            sessionId: 's1', onEvent: jest.fn(), wsFactory: () => socket,
        });
        lane.sendAudio(Buffer.from([1]));
        lane.sendAudio(Buffer.from([2]));
        expect(socket.sent).toHaveLength(0);

        socket.emit('open');
        expect(socket.parsed('audio_input')).toHaveLength(2);
    });

    it('normalises partial and final transcripts to session-relative milliseconds', () => {
        const { socket, onEvent } = makeLane({ offsetMs: 5000 });

        socket.serverSays({ event: 'transcript.partial', text: 'hello', start_s: 1.5, end_s: 2.0 });
        socket.serverSays({
            event: 'transcript.final', text: 'hello there',
            start_s: 1.5, end_s: 2.4, utterance_idx: 3, confidence: 0.91,
        });

        expect(onEvent).toHaveBeenCalledTimes(2);
        expect(onEvent.mock.calls[0][0]).toMatchObject({
            lane: 'words', kind: 'partial', text: 'hello', t0Ms: 6500, t1Ms: 7000,
        });
        expect(onEvent.mock.calls[1][0]).toMatchObject({
            lane: 'words', kind: 'final', text: 'hello there', t0Ms: 6500, t1Ms: 7400,
            turnId: 3, confidence: 0.91,
        });
    });

    it('never emits a speaker field — speakers come from a separate lane', () => {
        const { socket, onEvent } = makeLane();
        socket.serverSays({ event: 'transcript.final', text: 'x', start_s: 0, end_s: 1 });
        const event = onEvent.mock.calls[0][0];
        expect(event.speakerLabel).toBeUndefined();
    });

    it('ignores VAD and session frames rather than forwarding them as transcripts', () => {
        const { socket, onEvent } = makeLane();
        socket.serverSays({ event: 'vad.speech_start' });
        socket.serverSays({ event: 'vad.speech_end', utterance_idx: 1 });
        socket.serverSays({ event: 'session.end', audio_duration_s: 40 });
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('records the config the server actually applied', () => {
        const { lane, socket } = makeLane();
        socket.serverSays({
            event: 'session.begin', request_id: 'r1',
            config: { model: MODEL, silence_duration_ms: 1000 },
        });
        expect(lane.health().appliedConfig).toEqual({ model: MODEL, silence_duration_ms: 1000 });
    });

    it('surfaces server errors with their fatal flag', () => {
        const { socket, onError } = makeLane();
        socket.serverSays({ event: 'error', code: 'invalid_model', message: 'nope', is_fatal: true });
        expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ fatal: true }));
        expect(onError.mock.calls[0][0].message).toBe('nope');
    });

    it('survives a non-JSON frame without emitting or throwing', () => {
        const { socket, onEvent, onError } = makeLane();
        expect(() => socket.emit('message', Buffer.from('<html>502</html>'))).not.toThrow();
        expect(onEvent).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it('flush asks the server to finalise without waiting for the VAD window', () => {
        const { lane, socket } = makeLane();
        lane.flush();
        expect(socket.parsed('flush')).toHaveLength(1);
    });

    it('stops accepting audio once closed', () => {
        const { lane, socket, onClose } = makeLane();
        socket.close();
        expect(onClose).toHaveBeenCalled();
        expect(lane.sendAudio(Buffer.from([1]))).toBe(false);
    });

    it('reports health counters', () => {
        const { lane, socket } = makeLane();
        lane.sendAudio(Buffer.from([1]));
        lane.sendAudio(Buffer.from([2]));
        socket.serverSays({ event: 'transcript.final', text: 'a', start_s: 0, end_s: 1 });

        expect(lane.health()).toMatchObject({ lane: 'words', open: true, framesSent: 2, finals: 1 });
    });

    it('throws when no Sarvam key is configured', () => {
        const cfg = require('../src/core/config');
        const keys = cfg.inference.sarvamKeys;
        cfg.inference.sarvamKeys = [];
        try {
            expect(() => createSarvamRealtimeLane({ sessionId: 's', onEvent: jest.fn() }))
                .toThrow(/No Sarvam API key/);
        } finally {
            cfg.inference.sarvamKeys = keys;
        }
    });

    it('requires an onEvent callback', () => {
        expect(() => createSarvamRealtimeLane({ sessionId: 's' })).toThrow(/onEvent is required/);
    });
});

describe('normalise', () => {
    it('returns null for frames that are not transcripts', () => {
        expect(normalise({ event: 'session.begin' }, 0)).toBeNull();
        expect(normalise({ event: 'vad.speech_start' }, 0)).toBeNull();
    });

    it('tolerates a missing text field', () => {
        expect(normalise({ event: 'transcript.final', start_s: 0, end_s: 1 }, 0).text).toBe('');
    });
});
