jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecorder, sliceAudio, wavHeader } = require('../src/realtime/recorder');

const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 3200 bytes per 100ms frame

const makeFrame = (fillByte, bytes = FRAME_BYTES) => Buffer.alloc(bytes, fillByte);

describe('recorder', () => {
    let dir;
    let recorder;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
        recorder = createRecorder({ dir, sampleRate: SAMPLE_RATE });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lands frames in the spool file', async () => {
        recorder.write('m1', makeFrame(1));
        recorder.write('m1', makeFrame(2));
        const result = await recorder.close('m1');

        expect(result.bytes).toBe(FRAME_BYTES * 2);
        expect(fs.statSync(result.path).size).toBe(44 + FRAME_BYTES * 2);
    });

    it('writes a correct WAV header', async () => {
        recorder.write('m1', makeFrame(1));
        const { path: file, bytes } = await recorder.close('m1');
        const buffer = fs.readFileSync(file);

        expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
        expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');
        expect(buffer.toString('ascii', 12, 16)).toBe('fmt ');
        expect(buffer.readUInt32LE(24)).toBe(SAMPLE_RATE);
        expect(buffer.readUInt32LE(28)).toBe(SAMPLE_RATE * 2);
        expect(buffer.readUInt16LE(32)).toBe(2);
        expect(buffer.readUInt16LE(34)).toBe(16);
        expect(buffer.toString('ascii', 36, 40)).toBe('data');
        expect(buffer.readUInt32LE(40)).toBe(bytes);
        expect(buffer.readUInt32LE(4)).toBe(36 + bytes);
    });

    it('reports the right duration on close and load', async () => {
        recorder.write('m1', makeFrame(1));
        recorder.write('m1', makeFrame(1));
        recorder.write('m1', makeFrame(1));
        const result = await recorder.close('m1');
        expect(result.durationMs).toBe(FRAME_MS * 3);

        const loaded = await recorder.load('m1');
        expect(loaded.durationMs).toBe(FRAME_MS * 3);
    });

    it('slices audio by time and returns the right bytes', async () => {
        recorder.write('m1', makeFrame(1));
        recorder.write('m1', makeFrame(2));
        recorder.write('m1', makeFrame(3));
        await recorder.close('m1');
        const { buffer } = await recorder.load('m1');

        const slice = sliceAudio(buffer, 100, 200, SAMPLE_RATE);
        expect(slice.length).toBe(44 + FRAME_BYTES);
        expect(slice.readUInt32LE(40)).toBe(FRAME_BYTES);
        expect(slice.subarray(44).every((b) => b === 2)).toBe(true);
    });

    it('clamps out-of-range slice times to the buffer', async () => {
        recorder.write('m1', makeFrame(1));
        await recorder.close('m1');
        const { buffer } = await recorder.load('m1');

        const slice = sliceAudio(buffer, -500, 10000, SAMPLE_RATE);
        expect(slice.length).toBe(44 + FRAME_BYTES);
    });

    it('returns an empty wav for an inverted range', async () => {
        recorder.write('m1', makeFrame(1));
        await recorder.close('m1');
        const { buffer } = await recorder.load('m1');

        const slice = sliceAudio(buffer, 80, 20, SAMPLE_RATE);
        expect(slice.length).toBe(44);
        expect(slice.readUInt32LE(40)).toBe(0);
    });

    it('returns an empty wav for a range entirely past the end', async () => {
        recorder.write('m1', makeFrame(1));
        await recorder.close('m1');
        const { buffer } = await recorder.load('m1');

        const slice = sliceAudio(buffer, 500, 900, SAMPLE_RATE);
        expect(slice.length).toBe(44);
    });

    it('keeps two concurrent meetings separate', async () => {
        recorder.write('a', makeFrame(9));
        recorder.write('b', makeFrame(7));
        recorder.write('a', makeFrame(9));

        const resultA = await recorder.close('a');
        const resultB = await recorder.close('b');
        expect(resultA.bytes).toBe(FRAME_BYTES * 2);
        expect(resultB.bytes).toBe(FRAME_BYTES);

        const loadedA = await recorder.load('a');
        const loadedB = await recorder.load('b');
        expect(loadedA.buffer.subarray(44).every((b) => b === 9)).toBe(true);
        expect(loadedB.buffer.subarray(44).every((b) => b === 7)).toBe(true);
    });

    it('is idempotent on close', async () => {
        recorder.write('m1', makeFrame(1));
        const first = await recorder.close('m1');
        const second = await recorder.close('m1');

        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it('returns null for an unknown meeting on close and load', async () => {
        expect(await recorder.close('ghost')).toBeNull();
        expect(await recorder.load('ghost')).toBeNull();
    });

    it('does not crash on a write after close', async () => {
        recorder.write('m1', makeFrame(1));
        await recorder.close('m1');

        expect(() => recorder.write('m1', makeFrame(1))).not.toThrow();
        await recorder.close('m1'); // clean up the stream opened by the write above
    });

    it('tracks the number of open spools', async () => {
        expect(recorder.active()).toBe(0);
        recorder.write('m1', makeFrame(1));
        recorder.write('m2', makeFrame(1));
        expect(recorder.active()).toBe(2);

        await recorder.close('m1');
        expect(recorder.active()).toBe(1);
        await recorder.close('m2');
    });

    it('discards a finalised recording', async () => {
        recorder.write('m1', makeFrame(1));
        await recorder.close('m1');

        expect(await recorder.discard('m1')).toBe(true);
        expect(await recorder.load('m1')).toBeNull();
        expect(await recorder.discard('m1')).toBe(false);
    });

    it('sanitises meeting ids that could escape the spool directory', async () => {
        recorder.write('../../evil', makeFrame(1));
        const result = await recorder.close('../../evil');

        expect(result).not.toBeNull();
        expect(path.dirname(result.path)).toBe(dir);
    });
});

describe('wavHeader', () => {
    it('produces a 44-byte RIFF/WAVE header with the right sizes', () => {
        const header = wavHeader(1000, SAMPLE_RATE);

        expect(header.length).toBe(44);
        expect(header.toString('ascii', 0, 4)).toBe('RIFF');
        expect(header.toString('ascii', 8, 12)).toBe('WAVE');
        expect(header.readUInt32LE(4)).toBe(1036);
        expect(header.readUInt32LE(40)).toBe(1000);
    });
});

describe('destructive edge cases', () => {
    let tmp;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-edge-')); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('ignores a frame arriving after close instead of truncating the recording', async () => {
        const rec = createRecorder({ dir: tmp });
        for (let i = 0; i < 10; i++) rec.write('m1', Buffer.alloc(3200));
        const closed = await rec.close('m1');
        const before = fs.statSync(closed.path).size;

        rec.write('m1', Buffer.alloc(3200));
        await new Promise((r) => setTimeout(r, 50));

        expect(fs.statSync(closed.path).size).toBe(before);
    });

    it('keeps two meeting ids that sanitise the same in separate files', async () => {
        const rec = createRecorder({ dir: tmp });
        rec.write('a/b', Buffer.alloc(1600));
        rec.write('a_b', Buffer.alloc(3200));

        const first = await rec.close('a/b');
        const second = await rec.close('a_b');

        expect(first.path).not.toBe(second.path);
        expect(first.bytes).toBe(1600);
        expect(second.bytes).toBe(3200);
    });
});
