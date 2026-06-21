// utils/llm/resilientCall.js
//
// Resilient retry for third-party LLM/embedding calls. Grounded in AWS "Exponential Backoff
// and Jitter" (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/):
// retries use FULL JITTER so concurrent workers don't retry in synchronized bursts (which
// turns a transient 429 into a retry storm / metastable failure). 429 responses honor the
// provider's Retry-After header when present; retries are hard-capped.
//
// This is the single wrapper all provider calls should go through. Concurrency shaping
// (Bottleneck) and circuit-breaking (opossum) layer on top of this in later steps.

/** True if the error represents an HTTP 429 rate-limit, across SDK error shapes. */
function isRateLimit(err) {
    if (!err) return false;
    return err.status === 429 || err.code === 429 ||
        (typeof err.message === 'string' && err.message.includes('429'));
}

/** True if the error is a retryable 5xx server/transport error. */
function isRetryableServer(err) {
    const s = err && (err.status ?? err.code);
    return s === 500 || s === 502 || s === 503 || s === 504;
}

/** Extracts a Retry-After delay (ms) from common header locations, or null. */
function getRetryAfterMs(err) {
    const headers = err && (err.headers || err.responseHeaders || (err.response && err.response.headers));
    if (!headers) return null;
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    if (raw == null) return null;
    const secs = Number(raw);
    return Number.isNaN(secs) ? null : Math.max(0, secs * 1000);
}

/**
 * Full-jitter backoff delay for a given attempt:
 *   delay = random(0, min(cap, base * 2^attempt))
 * @param {number} attempt 0-based attempt index
 * @param {number} base base delay (ms)
 * @param {number} cap maximum delay (ms)
 * @param {() => number} [rand] injectable RNG (tests)
 */
function fullJitterDelay(attempt, base, cap, rand = Math.random) {
    const exp = Math.min(cap, base * Math.pow(2, attempt));
    return Math.floor(rand() * exp);
}

/**
 * Runs `fn`, retrying on rate-limit/5xx with full jitter (or Retry-After) up to a cap.
 * @param {() => Promise<any>} fn
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=3]
 * @param {number} [opts.baseDelayMs=500]
 * @param {number} [opts.capDelayMs=20000]
 * @param {(err:any)=>boolean} [opts.retryOn] predicate (default: 429 or 5xx)
 * @param {(ms:number)=>Promise<void>} [opts.sleep] injectable sleep (tests)
 * @param {()=>number} [opts.rand] injectable RNG (tests)
 * @param {(info:{attempt:number,delay:number,error:any})=>void} [opts.onRetry]
 */
async function withRetry(fn, opts = {}) {
    const {
        maxRetries = 3,
        baseDelayMs = 500,
        capDelayMs = 20000,
        retryOn = (err) => isRateLimit(err) || isRetryableServer(err),
        sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
        rand = Math.random,
        onRetry = () => {},
    } = opts;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= maxRetries || !retryOn(err)) throw err;
            const retryAfter = getRetryAfterMs(err);
            const delay = retryAfter != null ? retryAfter : fullJitterDelay(attempt, baseDelayMs, capDelayMs, rand);
            onRetry({ attempt: attempt + 1, delay, error: err });
            await sleep(delay);
            attempt++;
        }
    }
}

module.exports = { withRetry, fullJitterDelay, getRetryAfterMs, isRateLimit, isRetryableServer };
