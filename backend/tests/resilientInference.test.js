// tests/resilientInference.test.js
// runResilient composes breaker → limiter → jittered retry. We verify the observable behavior:
// success passes through, transient 429 is retried then succeeds, and a non-retryable error throws.

const { runResilient, _resetForTests } = require('../utils/llm/resilientInference');

beforeEach(() => _resetForTests());

describe('runResilient', () => {
    it('returns the result on success', async () => {
        const out = await runResilient('test-provider', async () => 'ok');
        expect(out).toBe('ok');
    });

    it('retries a transient 429 then succeeds (fast, no real wait)', async () => {
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls === 1) throw { status: 429, headers: { 'retry-after': '0' } };
            return 'done';
        };
        const out = await runResilient('test-provider', fn, { sleep: (ms) => Promise.resolve() });
        expect(out).toBe('done');
        expect(calls).toBe(2);
    });

    it('throws a non-retryable error without retrying', async () => {
        let calls = 0;
        const fn = async () => { calls++; throw { status: 400, message: 'bad request' }; };
        await expect(runResilient('test-provider', fn)).rejects.toMatchObject({ status: 400 });
        expect(calls).toBe(1);
    });
});
