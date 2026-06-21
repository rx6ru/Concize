// tests/resilientCall.test.js
// TDD for the resilient retry helper: full jitter + Retry-After + bounded attempts.
// Grounded in AWS "Exponential Backoff and Jitter" — jitter randomizes the delay across
// [0, min(cap, base*2^n)] so concurrent clients don't retry in synchronized bursts.

const {
    withRetry,
    fullJitterDelay,
    getRetryAfterMs,
    isRateLimit,
    isRetryableServer,
} = require('../utils/llm/resilientCall');

describe('fullJitterDelay', () => {
    it('returns a value within [0, min(cap, base*2^attempt)]', () => {
        // rand=1 → upper bound; rand=0 → 0
        expect(fullJitterDelay(0, 500, 20000, () => 1)).toBe(500);
        expect(fullJitterDelay(1, 500, 20000, () => 1)).toBe(1000);
        expect(fullJitterDelay(2, 500, 20000, () => 1)).toBe(2000);
        expect(fullJitterDelay(10, 500, 20000, () => 1)).toBe(20000); // capped
        expect(fullJitterDelay(3, 500, 20000, () => 0)).toBe(0);
    });
});

describe('error classifiers', () => {
    it('isRateLimit detects 429 across shapes', () => {
        expect(isRateLimit({ status: 429 })).toBe(true);
        expect(isRateLimit({ code: 429 })).toBe(true);
        expect(isRateLimit({ message: 'Error 429: too many' })).toBe(true);
        expect(isRateLimit({ status: 400 })).toBe(false);
    });
    it('isRetryableServer detects 5xx only', () => {
        expect(isRetryableServer({ status: 503 })).toBe(true);
        expect(isRetryableServer({ status: 500 })).toBe(true);
        expect(isRetryableServer({ status: 429 })).toBe(false);
        expect(isRetryableServer({ status: 400 })).toBe(false);
    });
});

describe('getRetryAfterMs', () => {
    it('reads Retry-After (seconds) from common header locations', () => {
        expect(getRetryAfterMs({ headers: { 'retry-after': '2' } })).toBe(2000);
        expect(getRetryAfterMs({ response: { headers: { 'Retry-After': '5' } } })).toBe(5000);
        expect(getRetryAfterMs({ status: 429 })).toBeNull();
    });
});

describe('withRetry', () => {
    const ok = async () => 'result';

    it('returns immediately on success without sleeping', async () => {
        const sleep = jest.fn();
        const out = await withRetry(ok, { sleep });
        expect(out).toBe('result');
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries 429 up to maxRetries then throws', async () => {
        const sleep = jest.fn().mockResolvedValue();
        const fn = jest.fn().mockRejectedValue({ status: 429 });
        await expect(withRetry(fn, { maxRetries: 3, sleep, rand: () => 1 })).rejects.toMatchObject({ status: 429 });
        expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
        expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('succeeds after a transient 429', async () => {
        const sleep = jest.fn().mockResolvedValue();
        const fn = jest.fn()
            .mockRejectedValueOnce({ status: 429 })
            .mockResolvedValueOnce('ok');
        const out = await withRetry(fn, { sleep, rand: () => 0.5 });
        expect(out).toBe('ok');
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('honors Retry-After over jitter', async () => {
        const sleep = jest.fn().mockResolvedValue();
        const fn = jest.fn()
            .mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '7' } })
            .mockResolvedValueOnce('ok');
        await withRetry(fn, { sleep, rand: () => 1 });
        expect(sleep).toHaveBeenCalledWith(7000);
    });

    it('does NOT retry a non-retryable error (e.g. 400)', async () => {
        const sleep = jest.fn();
        const fn = jest.fn().mockRejectedValue({ status: 400 });
        await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ status: 400 });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries 5xx', async () => {
        const sleep = jest.fn().mockResolvedValue();
        const fn = jest.fn()
            .mockRejectedValueOnce({ status: 503 })
            .mockResolvedValueOnce('ok');
        const out = await withRetry(fn, { sleep, rand: () => 0 });
        expect(out).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
