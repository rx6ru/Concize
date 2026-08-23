const test = require('node:test');
const assert = require('node:assert');

// popup.js is loaded by the browser as a plain script and grabs its elements at load, so the
// smallest possible DOM has to exist before it is required.
class El {
    constructor(id) {
        this.id = id;
        this.children = [];
        this._text = '';
        this.innerHTML = '';
        this.value = '';
        this.disabled = false;
        this.style = {};
        this.classList = {
            _s: new Set(),
            add: (c) => this.classList._s.add(c),
            remove: (c) => this.classList._s.delete(c),
            contains: (c) => this.classList._s.has(c),
        };
        this.listeners = {};
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v; this.children = []; }
    append(...kids) { this.children.push(...kids); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { return Promise.all((this.listeners.click || []).map((f) => f())); }
}

const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };

let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });

function install() {
    els.clear();
    global.document = {
        getElementById: (id) => el(id),
        createElement: (tag) => new El(tag),
        addEventListener() {},
    };
    global.window = { close() {} };
    global.chrome = {
        runtime: { sendMessage() {}, getURL: (p) => p, onMessage: { addListener() {} } },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        windows: { create() {} },
        tabs: { query: async () => [{ id: 1, url: 'https://example.com' }], update: async () => {} },
        offscreen: { hasDocument: async () => false, createDocument: async () => {} },
        action: { setIcon() {} },
        permissions: { contains: async () => true },
    };
    global.ConcizeAuth = { authedFetch: (...a) => fetchImpl(...a), getSession: async () => ({ access_token: 't' }) };
    global.ConcizeMarkdown = { renderSafe: (s) => s };
    global.ConcizeLiveRender = {
        partialTracker: () => ({ set() {}, clear() {}, get: () => null }),
        turnKey: (t) => t && t.turnId,
    };

    delete require.cache[require.resolve('../popup.js')];
    return require('../popup.js');
}

const defer = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test('a slow meeting load cannot bind the share panel to a meeting that is no longer open', async () => {
    const popup = install();

    // Meeting A's shares are slow; meeting B is a shared meeting, so its /shares 403s.
    fetchImpl = async (path) => {
        if (path.includes('/A/shares')) {
            await defer(40);
            return { ok: true, status: 200, json: async () => ({ shares: [] }) };
        }
        if (path.includes('/B/shares')) return { ok: false, status: 403, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ summary: null, utterances: [] }) };
    };

    const a = popup.openMeeting('A');
    await defer(5);
    const b = popup.openMeeting('B');
    await Promise.all([a, b]);
    await defer(60);

    assert.notStrictEqual(popup.currentShare(), 'A',
        'the share controls stayed bound to a meeting the user had already navigated away from');
});

test('a transcript longer than one page is fetched whole, not truncated at the cap', async () => {
    const popup = install();

    // 1,150 utterances: three pages at the server's 500 cap.
    const total = 1150;
    const page = (start, n) => Array.from({ length: n }, (_, i) => ({
        turnId: String(start + i), seq: start + i, t0: 0, t1: 900,
        text: `line ${start + i}`, speaker: 'S0', speakerName: 'S0',
    }));

    const asked = [];
    fetchImpl = async (path) => {
        if (!path.includes('/utterances')) {
            return { ok: true, status: 200, json: async () => ({ summary: null, shares: [] }) };
        }
        const after = /after=(\d+)/.exec(path);
        const start = after ? Number(after[1]) + 1 : 0;
        asked.push(start);
        const n = Math.min(500, total - start);
        const nextCursor = start + n < total ? start + n - 1 : null;
        return { ok: true, status: 200, json: async () => ({ utterances: page(start, n), nextCursor }) };
    };

    await popup.openMeeting('LONG');

    assert.deepStrictEqual(asked, [0, 500, 1000], 'should have followed the cursor across three pages');
});

test('a failed delete still needs two clicks the next time', async () => {
    const popup = install();
    fetchImpl = async () => { throw new Error('network down'); };

    const button = popup.deleteControl({ meetingId: 'M1' });
    await button.click();                       // arms
    assert.strictEqual(button.textContent, 'Sure?');
    await button.click();                       // attempts, fails

    assert.strictEqual(button.textContent, 'Delete', 'the button should look unarmed after a failure');

    // The next single click must only re-arm, never delete.
    let deleteAttempts = 0;
    fetchImpl = async () => { deleteAttempts += 1; return { ok: true, status: 204, json: async () => ({}) }; };
    await button.click();

    assert.strictEqual(deleteAttempts, 0,
        'one click deleted the meeting: the confirmation was still armed from the failed attempt');
    assert.strictEqual(button.textContent, 'Sure?');
});
