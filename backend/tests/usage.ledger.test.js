jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUsageLedger } = require('../src/core/usage.ledger');

let dir;
const build = (over = {}) => createUsageLedger({
    file: path.join(dir, 'usage.jsonl'),
    today: () => '2026-08-09',
    ...over,
});

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('recording', () => {
    it('accumulates tokens for a model across calls', () => {
        const ledger = build();
        ledger.record('groq', 'openai/gpt-oss-120b', 1200);
        ledger.record('groq', 'openai/gpt-oss-120b', 800);

        expect(ledger.spentToday('groq', 'openai/gpt-oss-120b')).toBe(2000);
    });

    it('keeps models apart', () => {
        const ledger = build();
        ledger.record('groq', 'openai/gpt-oss-120b', 1000);
        ledger.record('groq', 'llama-3.3-70b-versatile', 500);

        expect(ledger.spentToday('groq', 'openai/gpt-oss-120b')).toBe(1000);
        expect(ledger.spentToday('groq', 'llama-3.3-70b-versatile')).toBe(500);
    });

    it('counts requests as well as tokens, since some caps are per request', () => {
        const ledger = build();
        ledger.record('gemini', 'gemini-embedding-001', 0);
        ledger.record('gemini', 'gemini-embedding-001', 0);

        expect(ledger.requestsToday('gemini', 'gemini-embedding-001')).toBe(2);
    });

    it('ignores a day that is not today, so a cap that resets is not double-counted', () => {
        const file = path.join(dir, 'usage.jsonl');
        fs.writeFileSync(file,
            JSON.stringify({ day: '2026-08-08', provider: 'groq', model: 'm', tokens: 999, requests: 1 }) + '\n');

        expect(build().spentToday('groq', 'm')).toBe(0);
    });

    // Several processes write this: the backend during a meeting, the harness during a run.
    it('survives a second writer appending to the same file', () => {
        const a = build();
        const b = build();
        a.record('groq', 'm', 100);
        b.record('groq', 'm', 250);

        expect(build().spentToday('groq', 'm')).toBe(350);
    });

    it('starts empty rather than throwing when the file does not exist', () => {
        expect(build().spentToday('groq', 'm')).toBe(0);
    });

    it('skips a corrupt line instead of losing the whole ledger', () => {
        const file = path.join(dir, 'usage.jsonl');
        fs.writeFileSync(file,
            JSON.stringify({ day: '2026-08-09', provider: 'groq', model: 'm', tokens: 10, requests: 1 }) + '\n'
            + 'not json\n');

        expect(build().spentToday('groq', 'm')).toBe(10);
    });
});

describe('what is left', () => {
    it('reports the remaining daily token budget', () => {
        const ledger = build();
        ledger.record('groq', 'openai/gpt-oss-120b', 150000);

        expect(ledger.remainingToday('groq', 'openai/gpt-oss-120b')).toEqual(
            expect.objectContaining({ tokens: 50000 })
        );
    });

    it('reports the remaining daily request budget', () => {
        const ledger = build();
        for (let i = 0; i < 40; i++) ledger.record('gemini', 'gemini-embedding-001', 0);

        expect(ledger.remainingToday('gemini', 'gemini-embedding-001').requests).toBe(960);
    });

    // Unknown means unknown. Reporting 0 left would stop work that is actually fine.
    it('reports null for a model with no recorded cap', () => {
        const r = build().remainingToday('groq', 'qwen/qwen3.6-27b');
        expect(r.tokens).toBeNull();
    });

    it('does not go negative once the cap is blown', () => {
        const ledger = build();
        ledger.record('groq', 'openai/gpt-oss-120b', 250000);

        expect(ledger.remainingToday('groq', 'openai/gpt-oss-120b').tokens).toBe(0);
    });
});

describe('unreadable ledger', () => {
    // A missing file is not the same failure as a file that exists but can't be read: only the
    // first one means "nothing spent yet". Reproduced with a real unreadable path (a directory
    // where the ledger file should be), not a mocked fs error, so the real error code is what
    // trips the branch.
    const buildUnreadable = () => {
        const file = path.join(dir, 'usage.jsonl');
        fs.mkdirSync(file);
        return build();
    };

    it('does not confuse "unreadable" with "empty": spentToday still reads 0, not a thrown error', () => {
        expect(buildUnreadable().spentToday('groq', 'm')).toBe(0);
    });

    it('flags remainingToday as unreadable rather than reporting the usual null/left numbers', () => {
        const r = buildUnreadable().remainingToday('groq', 'openai/gpt-oss-120b');
        expect(r.unreadable).toBe(true);
    });

    it('a genuinely missing file is not flagged unreadable', () => {
        const r = build().remainingToday('groq', 'openai/gpt-oss-120b');
        expect(r.unreadable).toBe(false);
    });
});
