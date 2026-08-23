const test = require('node:test');
const assert = require('node:assert');

const { SampleBatcher, BATCH_SAMPLES } = require('../audio-capture.worklet.js');

test('input smaller than the batch size does not emit', () => {
    const batcher = new SampleBatcher(100);
    const emitted = [];
    batcher.push(new Float32Array(60), (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 0);
});

test('input exactly one batch emits once and resets the offset', () => {
    const batcher = new SampleBatcher(100);
    const emitted = [];
    batcher.push(new Float32Array(100), (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].length, 100);
    assert.strictEqual(batcher.offset, 0);
});

test('input spanning several batches emits each full batch and carries the remainder', () => {
    const batcher = new SampleBatcher(100);
    const emitted = [];
    batcher.push(new Float32Array(250), (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 2, '250 samples is two full batches with 50 left over');
    assert.strictEqual(batcher.offset, 50);
});

test('a batch spanning two push calls emits once the second call fills it', () => {
    const batcher = new SampleBatcher(100);
    const emitted = [];
    batcher.push(new Float32Array(70), (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 0);
    batcher.push(new Float32Array(30), (f) => emitted.push(f));
    assert.strictEqual(emitted.length, 1);
});

test('sample values and order are preserved', () => {
    const batcher = new SampleBatcher(4);
    const emitted = [];
    batcher.push(Float32Array.from([0.1, 0.2, 0.3, 0.4]), (f) => emitted.push(f));
    assert.deepStrictEqual(Array.from(emitted[0]), [0.1, 0.2, 0.3, 0.4].map((v) => Math.fround(v)));
});

test('emitted batches are copies, not views into the internal buffer', () => {
    const batcher = new SampleBatcher(4);
    const emitted = [];
    batcher.push(Float32Array.from([1, 2, 3, 4]), (f) => emitted.push(f));
    batcher.push(Float32Array.from([5, 6, 7, 8]), (f) => emitted.push(f));
    assert.deepStrictEqual(Array.from(emitted[0]), [1, 2, 3, 4], 'the first emission must not be overwritten by the second');
});

test('the default batch size matches the exported constant', () => {
    const batcher = new SampleBatcher();
    assert.strictEqual(batcher.buffer.length, BATCH_SAMPLES);
});
