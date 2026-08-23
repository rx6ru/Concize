jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUsageLedger } = require('../src/core/usage.ledger');
const { isOverBudget } = require('../src/core/cost.breaker');

let dir;
const buildLedger = () => createUsageLedger({ file: path.join(dir, 'usage.jsonl'), today: () => '2026-08-09' });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('vendor cap (provider.limits.json)', () => {
    it('allows a model with no recorded cap and no override', () => {
        const ledger = buildLedger();
        // qwen/qwen3.6-27b carries no tokensPerDay/requestsPerDay in provider.limits.json.
        expect(isOverBudget('groq', 'qwen/qwen3.6-27b', { ledger })).toBe(false);
    });

    it('passes when today\'s spend is under the tokensPerDay cap', () => {
        const ledger = buildLedger();
        // llama-3.3-70b-versatile: tokensPerDay 100000.
        ledger.record('groq', 'llama-3.3-70b-versatile', 50000);
        expect(isOverBudget('groq', 'llama-3.3-70b-versatile', { ledger })).toBe(false);
    });

    it('blocks once today\'s spend reaches the tokensPerDay cap', () => {
        const ledger = buildLedger();
        ledger.record('groq', 'llama-3.3-70b-versatile', 100000);
        expect(isOverBudget('groq', 'llama-3.3-70b-versatile', { ledger })).toBe(true);
    });

    it('blocks once past the cap, not only exactly at it', () => {
        const ledger = buildLedger();
        ledger.record('groq', 'llama-3.3-70b-versatile', 150000);
        expect(isOverBudget('groq', 'llama-3.3-70b-versatile', { ledger })).toBe(true);
    });

    it('blocks on requestsPerDay too, not only tokens', () => {
        const ledger = buildLedger();
        // gemini-embedding-001: requestsPerDay 1000.
        for (let i = 0; i < 1000; i++) ledger.record('gemini', 'gemini-embedding-001', 0);
        expect(isOverBudget('gemini', 'gemini-embedding-001', { ledger })).toBe(true);
    });

    it('passes under the requestsPerDay cap', () => {
        const ledger = buildLedger();
        for (let i = 0; i < 999; i++) ledger.record('gemini', 'gemini-embedding-001', 0);
        expect(isOverBudget('gemini', 'gemini-embedding-001', { ledger })).toBe(false);
    });
});

describe('operator override ceiling', () => {
    it('blocks once spend reaches the override, even far under the vendor cap', () => {
        const ledger = buildLedger();
        // openai/gpt-oss-120b vendor cap is 200000; nowhere near it.
        ledger.record('groq', 'openai/gpt-oss-120b', 5000);
        expect(isOverBudget('groq', 'openai/gpt-oss-120b', { ledger, ceilingTokens: 4000 })).toBe(true);
    });

    it('passes under the override', () => {
        const ledger = buildLedger();
        ledger.record('groq', 'openai/gpt-oss-120b', 5000);
        expect(isOverBudget('groq', 'openai/gpt-oss-120b', { ledger, ceilingTokens: 6000 })).toBe(false);
    });

    it('does not apply to a different provider/model\'s spend', () => {
        const ledger = buildLedger();
        ledger.record('groq', 'openai/gpt-oss-120b', 5000);
        expect(isOverBudget('cerebras', 'gpt-oss-120b', { ledger, ceilingTokens: 4000 })).toBe(false);
    });

    it('is inert (null) by default: only the vendor cap applies', () => {
        const ledger = buildLedger();
        ledger.record('groq', 'openai/gpt-oss-120b', 5000);
        expect(isOverBudget('groq', 'openai/gpt-oss-120b', { ledger })).toBe(false);
    });
});
