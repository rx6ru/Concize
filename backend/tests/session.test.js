jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createSession, LANE_STATES } = require('../src/realtime/session');

function fakeLane(overrides = {}) {
    return {
        sent: [],
        sendAudio(f) { this.sent.push(f); return true; },
        flush: jest.fn(),
        close: jest.fn(),
        health: () => ({ open: true }),
        ...overrides,
    };
}

function makeSession(over = {}) {
    const onEvent = jest.fn();
    const onLaneStatus = jest.fn();
    const session = createSession({
        meetingId: 'm1', ownerId: 'u1', onEvent, onLaneStatus, ...over,
    });
    return { session, onEvent, onLaneStatus };
}

describe('session clock', () => {
    it('derives timestamps from sequence number, not arrival time', () => {
        const { session } = makeSession();
        session.registerLane('words', fakeLane());

        expect(session.pushAudio(Buffer.alloc(2), 0)).toBe(0);
        expect(session.pushAudio(Buffer.alloc(2), 1)).toBe(100);
        expect(session.pushAudio(Buffer.alloc(2), 42)).toBe(4200);
    });

    it('gives a late frame the timestamp its sequence dictates', () => {
        const { session } = makeSession();
        session.registerLane('words', fakeLane());
        session.pushAudio(Buffer.alloc(2), 10);
        // arrives out of order; time comes from seq, so it is unchanged
        expect(session.pushAudio(Buffer.alloc(2), 5)).toBe(500);
    });

    it('counts dropped frames as gaps', () => {
        const { session } = makeSession();
        session.registerLane('words', fakeLane());
        session.pushAudio(Buffer.alloc(2), 0);
        session.pushAudio(Buffer.alloc(2), 3);
        expect(session.health().gaps).toBe(2);
    });
});

describe('fan-out', () => {
    it('sends every frame to every lane so they share one timeline', () => {
        const { session } = makeSession();
        const words = fakeLane();
        const speaker = fakeLane();
        session.registerLane('words', words).registerLane('speaker', speaker);

        const frame = Buffer.from([1, 2]);
        session.pushAudio(frame, 0);

        expect(words.sent).toEqual([frame]);
        expect(speaker.sent).toEqual([frame]);
    });

    it('keeps transcribing when a non-words lane throws', () => {
        const { session, onLaneStatus } = makeSession();
        const words = fakeLane();
        const speaker = fakeLane({ sendAudio() { throw new Error('speaker svc gone'); } });
        session.registerLane('words', words).registerLane('speaker', speaker);

        expect(() => session.pushAudio(Buffer.alloc(2), 0)).not.toThrow();
        expect(words.sent).toHaveLength(1);
        expect(onLaneStatus).toHaveBeenCalledWith(
            expect.objectContaining({ lane: 'speaker', status: LANE_STATES.DEGRADED })
        );
    });

    it('stops sending to a lane marked down, but keeps the others', () => {
        const { session } = makeSession();
        const words = fakeLane();
        const speaker = fakeLane();
        session.registerLane('words', words).registerLane('speaker', speaker);

        session.handleLaneError('speaker', new Error('fatal'), { fatal: true });
        session.pushAudio(Buffer.alloc(2), 0);

        expect(words.sent).toHaveLength(1);
        expect(speaker.sent).toHaveLength(0);
    });

    it('marks a lane recovered once it emits again', () => {
        const { session, onLaneStatus } = makeSession();
        session.registerLane('speaker', fakeLane());

        session.handleLaneError('speaker', new Error('blip'));
        session.handleLaneEvent('speaker', { kind: 'final', t1Ms: 100 });

        const statuses = onLaneStatus.mock.calls.map((c) => c[0].status);
        expect(statuses).toEqual([LANE_STATES.DEGRADED, LANE_STATES.UP]);
    });
});

describe('events and watermark', () => {
    it('stamps ownership onto every emitted event', () => {
        const { session, onEvent } = makeSession();
        session.registerLane('words', fakeLane());
        session.handleLaneEvent('words', { lane: 'words', kind: 'final', text: 'hi', t1Ms: 500 });

        expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({ meetingId: 'm1', ownerId: 'u1', text: 'hi' })
        );
    });

    it('advances the watermark on finals only', () => {
        const { session } = makeSession();
        session.registerLane('words', fakeLane());

        session.handleLaneEvent('words', { kind: 'partial', t1Ms: 9000 });
        expect(session.freshness().watermarkMs).toBe(0);

        session.handleLaneEvent('words', { kind: 'final', t1Ms: 2000 });
        expect(session.freshness().watermarkMs).toBe(2000);
    });

    it('never moves the watermark backwards on a late final', () => {
        const { session } = makeSession();
        session.registerLane('words', fakeLane());
        session.handleLaneEvent('words', { kind: 'final', t1Ms: 5000 });
        session.handleLaneEvent('words', { kind: 'final', t1Ms: 3000 });
        expect(session.freshness().watermarkMs).toBe(5000);
    });

    it('reports lag between live audio and the indexed transcript', () => {
        const { session } = makeSession();
        session.registerLane('words', fakeLane());
        session.pushAudio(Buffer.alloc(2), 99); // 10s of audio in
        session.handleLaneEvent('words', { kind: 'final', t1Ms: 8000 });

        expect(session.freshness()).toEqual({ watermarkMs: 8000, elapsedMs: 10000, lagMs: 2000 });
    });
});

describe('lifecycle', () => {
    it('flushes and closes every lane', async () => {
        const { session } = makeSession();
        const words = fakeLane();
        session.registerLane('words', words);

        await session.close();
        expect(words.flush).toHaveBeenCalled();
        expect(words.close).toHaveBeenCalled();
    });

    it('ignores audio and events after close', async () => {
        const { session, onEvent } = makeSession();
        const words = fakeLane();
        session.registerLane('words', words);
        await session.close();

        expect(session.pushAudio(Buffer.alloc(2), 0)).toBeNull();
        session.handleLaneEvent('words', { kind: 'final', t1Ms: 1 });
        expect(words.sent).toHaveLength(0);
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('survives a lane that throws while closing', async () => {
        const { session } = makeSession();
        session.registerLane('bad', fakeLane({ close() { throw new Error('nope'); } }));
        await expect(session.close()).resolves.toBeUndefined();
    });

    it('is idempotent on close', async () => {
        const { session } = makeSession();
        const words = fakeLane();
        session.registerLane('words', words);
        await session.close();
        await session.close();
        expect(words.close).toHaveBeenCalledTimes(1);
    });

    it('requires meetingId, ownerId and onEvent', () => {
        expect(() => createSession({ ownerId: 'u', onEvent: jest.fn() })).toThrow(/meetingId/);
        expect(() => createSession({ meetingId: 'm', onEvent: jest.fn() })).toThrow(/ownerId/);
        expect(() => createSession({ meetingId: 'm', ownerId: 'u' })).toThrow(/onEvent/);
    });
});
