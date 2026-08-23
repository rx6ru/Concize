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

// startRecording is the function whose auth-token bug meant the extension never recorded in a
// browser at all: it called ConcizeAuth.getSession(), which reads chrome.storage, and an MV3
// offscreen document has chrome.runtime and nothing else, so it threw before the socket opened.
// Nothing smaller than a full browser run covered it.
function installRecording(opts = {}) {
    const base = install(opts);
    const clients = [];

    global.ConcizeLiveClient = {
        LiveClient: class {
            constructor(cfg) { this.cfg = cfg; clients.push(this); }
            start() { this.started = true; }
            stop() { this.stopped = true; }
            pushAudio() {}
        },
    };
    global.ConcizeLiveRender = { partialTracker: () => ({}) };
    global.CONCIZE_CONFIG = { BACKEND_URL: 'http://localhost:3000' };
    global.AudioWorkletNode = class { constructor() { this.port = { onmessage: null }; } };
    global.window = { location: { hash: '' } };

    // The worklet and graph nodes the capture path builds after the stream is acquired.
    const AC = global.AudioContext;
    global.AudioContext = class extends AC {
        constructor() { super(); this.audioWorklet = { addModule: async () => {} }; }
        createGain() { const n = super.createGain(); n.gain = { value: 0 }; return n; }
    };

    return { ...base, clients };
}

test('threads the token from the message instead of reading chrome.storage', async () => {
    const { clients } = installRecording();
    const { startRecording } = load();

    await startRecording('stream-1', 'token-from-popup');

    assert.strictEqual(clients.length, 1, 'no live client was constructed');
    assert.strictEqual(clients[0].cfg.token, 'token-from-popup');
    assert.strictEqual(clients[0].started, true);
});

test('refuses to record without a token, and says so durably', async () => {
    const { messages, clients } = installRecording();
    const { startRecording } = load();

    await startRecording('stream-1', undefined);

    assert.strictEqual(clients.length, 0, 'a session was opened with no token');
    assert.ok(messages.find((m) => m.type === 'recording-error'));
    // The popup is usually gone by now, so the reason has to reach something that outlives it.
    assert.ok(messages.find((m) => m.type === 'recording-failed' && m.target === 'service-worker'),
        'nothing told the service worker, so the reason dies with the popup');
});

test('never touches chrome.storage, which does not exist in an offscreen document', async () => {
    const { clients } = installRecording();
    // Exactly how it fails in Chrome: the namespace is simply absent.
    delete global.chrome.storage;
    const { startRecording } = load();

    await startRecording('stream-1', 'token-from-popup');

    assert.strictEqual(clients.length, 1, 'startRecording reached for an API it cannot have');
});
