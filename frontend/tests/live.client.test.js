const test = require('node:test');
const assert = require('node:assert');

const { LiveClient } = require('../live.client.js');

// A WebSocket stand-in. Nothing here touches the network; what is under test is the client's
// lifecycle, not the browser's socket.
class FakeSocket {
    constructor(url) {
        FakeSocket.last = this;
        FakeSocket.opened.push(url);
        this.url = url;
        this.readyState = 0;
        this.sent = [];
    }

    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, wasClean: true }); }

    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    message(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code, wasClean: false }); }
}
FakeSocket.OPEN = 1;

function makeClient(over = {}) {
    FakeSocket.opened = [];
    const events = [];
    const client = new LiveClient({
        backendUrl: 'https://api.example.com',
        meetingId: 'm1',
        token: 't0k',
        WebSocketImpl: FakeSocket,
        onEvent: (e) => events.push(e),
        setTimeoutImpl: (fn) => { fn(); return 0; },   // reconnect immediately in tests
        ...over,
    });
    return { client, events };
}

test('connects to the realtime path with meeting and token in the query', () => {
    const { client } = makeClient();
    client.start();
    assert.match(FakeSocket.opened[0], /^wss:\/\/api\.example\.com\/rt\?/);
    assert.match(FakeSocket.opened[0], /meetingId=m1/);
    assert.match(FakeSocket.opened[0], /token=t0k/);
});

test('an http backend produces a ws url, not wss', () => {
    const { client } = makeClient({ backendUrl: 'http://localhost:3000' });
    client.start();
    assert.match(FakeSocket.opened[0], /^ws:\/\/localhost:3000\/rt\?/);
});

test('audio captured before the session is ready is held, then sent', () => {
    const { client } = makeClient();
    client.start();
    client.pushAudio(new Float32Array(1600), 16000);
    assert.strictEqual(FakeSocket.last.sent.length, 0, 'nothing goes out before ready');

    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready', meetingId: 'm1' });
    assert.strictEqual(FakeSocket.last.sent.length, 1, 'the held frame goes out on ready');
});

test('server messages reach the caller', () => {
    const { client, events } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    FakeSocket.last.message({ type: 'final', text: 'hello', t0Ms: 0, t1Ms: 900 });
    assert.deepStrictEqual(events.map((e) => e.type), ['session.ready', 'final']);
});

test('an unexpected drop reconnects', () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    assert.strictEqual(FakeSocket.opened.length, 1);

    FakeSocket.last.drop();
    assert.strictEqual(FakeSocket.opened.length, 2, 'a dropped socket is replaced');
});

test('sequence numbering restarts at zero on reconnect, which is what the server expects', () => {
    // gateway.js resumes a meeting by adding its own startOffsetMs to a client sequence that
    // begins again at 0. Continuing to count would rewrite the timeline from the beginning.
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    client.pushAudio(new Float32Array(3200), 16000);
    const seqOf = (buf) => new DataView(buf).getUint32(0, false);
    assert.deepStrictEqual(FakeSocket.last.sent.map(seqOf), [0, 1]);

    FakeSocket.last.drop();
    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    client.pushAudio(new Float32Array(1600), 16000);
    assert.deepStrictEqual(FakeSocket.last.sent.map(seqOf), [0]);
});

test('stop sends the stop event and does not reconnect', () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    const socket = FakeSocket.last;

    client.stop();
    const control = socket.sent.filter((s) => typeof s === 'string').map(JSON.parse);
    assert.deepStrictEqual(control.at(-1), { event: 'stop' });

    socket.drop();
    assert.strictEqual(FakeSocket.opened.length, 1, 'a deliberate stop is not a reason to reconnect');
});

test('stop flushes the tail of the meeting before saying stop', () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    client.pushAudio(new Float32Array(400), 16000);      // less than a frame
    assert.strictEqual(FakeSocket.last.sent.length, 0);

    client.stop();
    const binary = FakeSocket.last.sent.filter((s) => typeof s !== 'string');
    assert.strictEqual(binary.length, 1, 'the partial frame is sent, not dropped');
});

test('audio buffered while disconnected is bounded', () => {
    // A meeting that loses the network for an hour must not grow until the tab dies.
    const { client } = makeClient({ maxBufferedFrames: 3 });
    client.start();
    for (let i = 0; i < 10; i += 1) client.pushAudio(new Float32Array(1600), 16000);

    FakeSocket.last.open();
    FakeSocket.last.message({ type: 'session.ready' });
    assert.strictEqual(FakeSocket.last.sent.length, 3, 'the oldest frames are dropped, not the newest');
});
