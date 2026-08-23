const test = require('node:test');
const assert = require('node:assert');

// offscreen.js runs as a plain extension script, so the browser surfaces it touches have to exist
// before it is required. These are the smallest stand-ins that let the audio graph be built.
class FakeNode {
    constructor() { this.connected = []; this.gain = { value: null }; }
    connect(next) { this.connected.push(next); return next; }
}

function install({ tabFails = false, micFails = false } = {}) {
    const messages = [];
    const stopped = [];

    global.chrome = { runtime: { sendMessage: (m) => messages.push(m) } };

    const stream = (name) => ({ name, getTracks: () => [{ stop: () => stopped.push(name) }] });

    // Node ships a read-only `navigator`, so a plain assignment is silently dropped.
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
        mediaDevices: {
            getUserMedia: async (constraints) => {
                const isTab = !!constraints.audio.mandatory;
                if (isTab) {
                    if (tabFails) throw new Error('tab capture refused');
                    return stream('tab');
                }
                if (micFails) throw new Error('no microphone');
                return stream('mic');
            },
        },
    } });

    const sources = [];
    global.AudioContext = class {
        constructor() { this.destination = new FakeNode(); }
        createMediaStreamDestination() { return { stream: { name: 'mixed' } }; }
        createMediaStreamSource(s) { const n = new FakeNode(); n.from = s.name; sources.push(n); return n; }
        createGain() { return new FakeNode(); }
        async close() {}
    };

    return { messages, sources, stopped };
}

const load = () => {
    delete require.cache[require.resolve('../offscreen.js')];
    return require('../offscreen.js');
};

test('records tab audio even when the microphone is unavailable', async () => {
    const { messages, sources } = install({ micFails: true });
    const { getMediaStream } = load();

    const out = await getMediaStream('stream-1');

    assert.ok(out, 'a mic failure must not take tab audio down with it');
    assert.deepStrictEqual(sources.map((s) => s.from), ['tab']);
    assert.strictEqual(messages.filter((m) => m.type === 'recording-error').length, 0);
    assert.strictEqual(messages.find((m) => m.type === 'recording-degraded').source, 'tab-only');
});

test('records the microphone even when tab capture fails', async () => {
    const { messages, sources } = install({ tabFails: true });
    const { getMediaStream } = load();

    const out = await getMediaStream('stream-1');

    assert.ok(out);
    assert.deepStrictEqual(sources.map((s) => s.from), ['mic']);
    assert.strictEqual(messages.find((m) => m.type === 'recording-degraded').source, 'microphone-only');
});

test('mixes both sources and says nothing about degradation when both work', async () => {
    const { messages, sources } = install();
    const { getMediaStream } = load();

    await getMediaStream('stream-1');

    assert.deepStrictEqual(sources.map((s) => s.from), ['tab', 'mic']);
    assert.strictEqual(messages.filter((m) => m.type === 'recording-degraded').length, 0);
});

test('reports an error only when neither source is available', async () => {
    const { messages } = install({ tabFails: true, micFails: true });
    const { getMediaStream } = load();

    const out = await getMediaStream('stream-1');

    assert.strictEqual(out, null);
    assert.match(messages.find((m) => m.type === 'recording-error').error, /neither tab audio nor microphone/);
});
