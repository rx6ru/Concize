const test = require('node:test');
const assert = require('node:assert');

const {
    floatToPcm16, resampleTo16k, FrameSequencer, SAMPLE_RATE, FRAME_MS, FRAME_BYTES,
} = require('../audio.protocol.js');

test('a frame is exactly one frameMs of 16kHz mono PCM16', () => {
    // The server derives every timestamp from seq * frameMs, so a short or long frame does not
    // lose audio, it shifts the whole transcript after it.
    assert.strictEqual(SAMPLE_RATE, 16000);
    assert.strictEqual(FRAME_MS, 100);
    assert.strictEqual(FRAME_BYTES, 3200);
});

test('float samples convert to signed 16-bit', () => {
    const out = floatToPcm16(Float32Array.from([0, 1, -1, 0.5]));
    assert.strictEqual(out[0], 0);
    assert.strictEqual(out[1], 32767);
    assert.strictEqual(out[2], -32768);
    assert.ok(Math.abs(out[3] - 16383) <= 1);
});

test('samples beyond full scale clamp instead of wrapping', () => {
    // Without clamping, 1.5 wraps to a large negative and a loud passage turns to noise.
    const out = floatToPcm16(Float32Array.from([1.5, -1.5]));
    assert.strictEqual(out[0], 32767);
    assert.strictEqual(out[1], -32768);
});

test('resampling 48kHz to 16kHz keeps duration and drops the rate', () => {
    const input = new Float32Array(4800);          // 100ms at 48kHz
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 20);
    const out = resampleTo16k(input, 48000);
    assert.strictEqual(out.length, 1600);          // 100ms at 16kHz
});

test('audio already at 16kHz is passed through untouched', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    assert.strictEqual(resampleTo16k(input, 16000), input);
});

test('the sequencer emits whole frames only, and holds the remainder', () => {
    const seq = new FrameSequencer();
    const emitted = [];
    seq.push(new Float32Array(1000), 16000, (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 0, 'under a frame, nothing goes out');

    seq.push(new Float32Array(700), 16000, (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 1, '1700 samples is one frame with 100 left over');
    assert.strictEqual(emitted[0].byteLength, 4 + FRAME_BYTES);
});

test('sequence numbers start at zero and increase by one', () => {
    const seq = new FrameSequencer();
    const emitted = [];
    seq.push(new Float32Array(1600 * 3), 16000, (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 3);
    const seqOf = (buf) => new DataView(buf).getUint32(0, false);
    assert.deepStrictEqual(emitted.map(seqOf), [0, 1, 2]);
});

test('the sequence number is big-endian, which is what the server reads', () => {
    const seq = new FrameSequencer();
    seq.seq = 258;                                  // 0x00000102
    const out = [];
    seq.push(new Float32Array(1600), 16000, (f) => out.push(f));
    const bytes = new Uint8Array(out[0].slice(0, 4));
    assert.deepStrictEqual(Array.from(bytes), [0, 0, 1, 2]);
});

test('flush emits a trailing partial frame padded with silence', () => {
    // The tail of a meeting is a real utterance. Dropping it is how the last thing said is lost.
    const seq = new FrameSequencer();
    const out = [];
    seq.push(new Float32Array(400), 16000, (f) => out.push(f));
    seq.flush((f) => out.push(f));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].byteLength, 4 + FRAME_BYTES);
});

test('flush with nothing buffered emits nothing', () => {
    const seq = new FrameSequencer();
    const out = [];
    seq.flush((f) => out.push(f));
    assert.strictEqual(out.length, 0);
});
