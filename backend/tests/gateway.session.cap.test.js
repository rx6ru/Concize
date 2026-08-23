// Per-user concurrent WebSocket session cap, enforced at the upgrade in realtime/gateway.js.
// Drives a real HTTP server and real ws clients, same style as tests/gateway.test.js, focused
// on the cap rather than the rest of the gateway's behaviour.

const http = require('http');
const WebSocket = require('ws');

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { attachGateway } = require('../src/realtime/gateway');

function fakeLane() {
    return { sendAudio: () => {}, flush: jest.fn(), close: jest.fn(), health: () => ({ open: true }) };
}

async function startGateway(over = {}) {
    const server = http.createServer();
    const gw = attachGateway({
        flushGraceMs: 0,
        server,
        verifyAccessToken: async (token) => {
            if (token === 'user-A' || token === 'user-B') return { sub: token };
            throw new Error('bad token');
        },
        getMeetingOwner: async (id) => (id.startsWith('m-A') ? 'user-A' : id.startsWith('m-B') ? 'user-B' : null),
        createLane: () => fakeLane(),
        maxConcurrentPerUser: 2,
        ...over,
    });
    await new Promise((r) => server.listen(0, r));
    return { server, gw, port: server.address().port };
}

function connect(port, qs) {
    return new WebSocket(`ws://127.0.0.1:${port}/rt?${qs}`);
}

function waitReady(ws) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for session.ready')), 3000);
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'session.ready') { clearTimeout(timer); resolve(msg); }
        });
        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

let ctx;
afterEach(async () => {
    if (!ctx) return;
    await ctx.gw.closeAll();
    await new Promise((r) => ctx.server.close(r));
    ctx = null;
});

describe('per-user concurrent WS session cap', () => {
    it('allows connections up to the cap', async () => {
        ctx = await startGateway();
        const ws1 = connect(ctx.port, 'token=user-A&meetingId=m-A1');
        await waitReady(ws1);
        const ws2 = connect(ctx.port, 'token=user-A&meetingId=m-A2');
        await waitReady(ws2);

        expect(ctx.gw.sessionCount()).toBe(2);
        ws1.close(); ws2.close();
    });

    it('rejects the connection over the cap with a 429', async () => {
        ctx = await startGateway();
        const ws1 = connect(ctx.port, 'token=user-A&meetingId=m-A1');
        await waitReady(ws1);
        const ws2 = connect(ctx.port, 'token=user-A&meetingId=m-A2');
        await waitReady(ws2);

        const ws3 = connect(ctx.port, 'token=user-A&meetingId=m-A3');
        const err = await new Promise((resolve) => ws3.on('error', resolve));

        expect(err.message).toMatch(/429/);
        expect(ctx.gw.sessionCount()).toBe(2);
        ws1.close(); ws2.close();
    });

    it('does not count another user against this user\'s cap', async () => {
        ctx = await startGateway();
        const wsA1 = connect(ctx.port, 'token=user-A&meetingId=m-A1');
        await waitReady(wsA1);
        const wsA2 = connect(ctx.port, 'token=user-A&meetingId=m-A2');
        await waitReady(wsA2);

        // user A is at cap; user B must still be able to connect.
        const wsB1 = connect(ctx.port, 'token=user-B&meetingId=m-B1');
        await waitReady(wsB1);

        expect(ctx.gw.sessionCount()).toBe(3);
        wsA1.close(); wsA2.close(); wsB1.close();
    });

    it('frees a slot once a session disconnects', async () => {
        ctx = await startGateway();
        const ws1 = connect(ctx.port, 'token=user-A&meetingId=m-A1');
        await waitReady(ws1);
        const ws2 = connect(ctx.port, 'token=user-A&meetingId=m-A2');
        await waitReady(ws2);

        ws1.close();
        await new Promise((r) => setTimeout(r, 100));

        const ws3 = connect(ctx.port, 'token=user-A&meetingId=m-A3');
        await waitReady(ws3);

        expect(ctx.gw.sessionCount()).toBe(2);
        ws2.close(); ws3.close();
    });

    it('applies no cap when maxConcurrentPerUser is left at its default', async () => {
        ctx = await startGateway({ maxConcurrentPerUser: undefined });
        const ws1 = connect(ctx.port, 'token=user-A&meetingId=m-A1');
        await waitReady(ws1);
        const ws2 = connect(ctx.port, 'token=user-A&meetingId=m-A2');
        await waitReady(ws2);
        const ws3 = connect(ctx.port, 'token=user-A&meetingId=m-A3');
        await waitReady(ws3);

        expect(ctx.gw.sessionCount()).toBe(3);
        ws1.close(); ws2.close(); ws3.close();
    });
});
