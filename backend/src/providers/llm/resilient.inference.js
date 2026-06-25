//
// Outbound LLM/embedding calls run through:  limiter( retry-with-full-jitter( fn ) )  per provider.
//
// - Bottleneck limiter (per provider): bounds in-flight concurrency + min spacing so the worker
//   fleet never exceeds the provider's RPM/concurrency ceiling — this PREVENTS most 429s rather
//   than reacting to them.
// - withRetry: full-jitter, Retry-After-aware retry on 429/5xx (see resilientCall.js).
//
// Tunable via env: <PROVIDER>_MAX_CONCURRENT, <PROVIDER>_MIN_TIME_MS (e.g. GROQ_MAX_CONCURRENT=4),
// or the LLM_MAX_CONCURRENT default.
//
// NOTE: a per-provider circuit breaker + cross-provider failover (Groq→Cerebras) is the remaining
// piece of this workstream. It's deferred deliberately — it needs a cross-provider model mapping
// and careful timer lifecycle — and lands together with the queue-level retry (workstream E).

const Bottleneck = require('bottleneck');
const { withRetry } = require('./resilient.call');
const { createLogger } = require('../../core/logger');

const logger = createLogger('resilientInference');

const limiters = new Map();

function envNum(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

function getLimiter(provider) {
    if (!limiters.has(provider)) {
        const P = String(provider || 'default').toUpperCase();
        limiters.set(provider, new Bottleneck({
            maxConcurrent: envNum(`${P}_MAX_CONCURRENT`, envNum('LLM_MAX_CONCURRENT', 6)),
            minTime: Number(process.env[`${P}_MIN_TIME_MS`]) || 0,
        }));
    }
    return limiters.get(provider);
}

/**
 * Runs `fn` for a provider through the concurrency limiter + jittered retry.
 * @param {string} provider e.g. 'groq' | 'cerebras' | 'gemini' | 'sarvam'
 * @param {() => Promise<any>} fn the actual SDK/network call
 * @param {Object} [retryOpts] forwarded to withRetry (maxRetries, baseDelayMs, …)
 */
function runResilient(provider, fn, retryOpts = {}) {
    return getLimiter(provider).schedule(() =>
        withRetry(fn, {
            onRetry: ({ attempt, delay, error }) =>
                logger.warn('LLM call retry', {
                    provider, attempt, delay,
                    status: error && (error.status || error.code),
                }),
            ...retryOpts,
        })
    );
}

/** Releases limiter timers — call on graceful shutdown (and in test teardown). */
async function shutdown() {
    for (const limiter of limiters.values()) {
        try { await limiter.disconnect(); } catch { /* noop */ }
    }
    limiters.clear();
}

/** Test seam. */
function _resetForTests() {
    return shutdown();
}

module.exports = { runResilient, getLimiter, shutdown, _resetForTests };
