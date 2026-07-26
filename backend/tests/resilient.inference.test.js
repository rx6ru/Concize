// tests/resilientInference.test.js
// runResilient composes breaker → limiter → jittered retry. We verify the observable behavior:
// success passes through, transient 429 is retried then succeeds, and a non-retryable error throws.

const { runResilient, _resetForTests } = require('../src/providers/llm/resilient.inference');

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

// The limiter used to space every provider at 0ms, so it could not prevent a 429 however well
// documented the ceiling was. It now takes the spacing from core/provider.limits.json.
describe('spacing comes from the recorded limits', () => {
    afterEach(() => { delete process.env.GEMINI_MIN_TIME_MS; });

    it('spaces calls to a model with a per-minute request cap', async () => {
        const started = [];
        const stamp = async () => { started.push(Date.now()); return 'ok'; };

        // gemini-embedding-001 is recorded at 100 requests/minute, so 600ms apart.
        const t0 = Date.now();
        await Promise.all([
            runResilient('gemini', stamp, { model: 'gemini-embedding-001' }),
            runResilient('gemini', stamp, { model: 'gemini-embedding-001' }),
        ]);

        expect(started).toHaveLength(2);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    });

    it('does not space a provider with no per-minute cap recorded', async () => {
        const t0 = Date.now();
        await Promise.all([
            runResilient('groq', async () => 'ok', { model: 'openai/gpt-oss-120b' }),
            runResilient('groq', async () => 'ok', { model: 'openai/gpt-oss-120b' }),
        ]);
        expect(Date.now() - t0).toBeLessThan(400);
    });

    it('still lets an env override win', async () => {
        process.env.GEMINI_MIN_TIME_MS = '1';
        const t0 = Date.now();
        await Promise.all([
            runResilient('gemini', async () => 'ok', { model: 'gemini-embedding-001' }),
            runResilient('gemini', async () => 'ok', { model: 'gemini-embedding-001' }),
        ]);
        expect(Date.now() - t0).toBeLessThan(400);
    });
});
