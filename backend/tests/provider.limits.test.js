const {
    limitsFor, maxRequestTokens, fitsInOneRequest, minSpacingMs, maxConcurrent, knownModels,
} = require('../src/core/provider.limits');

describe('lookup', () => {
    it('reads a model limit', () => {
        expect(limitsFor('groq', 'llama-3.3-70b-versatile').tokensPerMinute).toBe(12000);
    });

    it('falls back to the provider default for a model not listed', () => {
        expect(limitsFor('groq', 'some-new-model').tokensPerMinute).toBe(8000);
    });

    it('falls back to the global default for an unknown provider', () => {
        expect(limitsFor('nobody', 'nothing').maxConcurrent).toBe(6);
    });

    it('lets a provider default override the global one', () => {
        expect(limitsFor('gemini', 'gemini-2.5-flash').maxConcurrent).toBe(4);
    });

    it('is case-insensitive on the provider', () => {
        expect(limitsFor('GROQ', 'openai/gpt-oss-120b').tokensPerMinute).toBe(8000);
    });

    // Invisible in every header; it only names itself in a 429 body once the day is spent.
    // Per model, and the models differ by 2x, so it must not be inherited from a sibling.
    it('exposes the daily token budget per model', () => {
        expect(limitsFor('groq', 'openai/gpt-oss-120b').tokensPerDay).toBe(200000);
        expect(limitsFor('groq', 'llama-3.3-70b-versatile').tokensPerDay).toBe(100000);
        expect(limitsFor('groq', 'qwen/qwen3.6-27b').tokensPerDay).toBeNull();
    });

    // A missing number must not read as "no limit" — the caller has to be able to tell.
    it('reports an unestablished limit as null rather than guessing', () => {
        expect(limitsFor('groq', 'openai/gpt-oss-120b').requestsPerMinute).toBeNull();
        expect(limitsFor('cerebras', 'anything').tokensPerMinute).toBeNull();
    });

    it('ignores the annotation keys', () => {
        expect(limitsFor('groq', 'openai/gpt-oss-120b')).not.toHaveProperty('_note');
        expect(knownModels('groq')).toEqual(expect.arrayContaining(['openai/gpt-oss-120b']));
        expect(knownModels('groq').filter((m) => m.startsWith('_'))).toEqual([]);
    });
});

describe('request sizing', () => {
    it('reports the largest prompt a model will accept', () => {
        expect(maxRequestTokens('groq', 'llama-3.3-70b-versatile')).toBe(12000);
    });

    it('accepts a prompt inside the limit and rejects one over it', () => {
        expect(fitsInOneRequest('groq', 'openai/gpt-oss-120b', 7900)).toBe(true);
        expect(fitsInOneRequest('groq', 'openai/gpt-oss-120b', 8529)).toBe(false);
    });

    // Refusing to send is worse than trying when nothing is actually known about the model.
    it('assumes a prompt fits when the limit is unknown', () => {
        expect(maxRequestTokens('gemini', 'gemini-2.5-flash')).toBeNull();
        expect(fitsInOneRequest('gemini', 'gemini-2.5-flash', 500000)).toBe(true);
    });
});

describe('spacing', () => {
    it('derives spacing from a per-minute request cap', () => {
        expect(minSpacingMs('gemini', 'gemini-embedding-001')).toBe(600);
    });

    it('does not manufacture spacing from a daily cap', () => {
        // 1000/day is a volume ceiling, not a reason to sit 86 seconds between calls.
        expect(minSpacingMs('groq', 'openai/gpt-oss-120b')).toBe(0);
    });

    it('reports concurrency per provider', () => {
        expect(maxConcurrent('gemini')).toBe(4);
        expect(maxConcurrent('groq')).toBe(6);
    });
});
