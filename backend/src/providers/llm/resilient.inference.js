// Outbound LLM/embedding calls run through: limiter( retry-with-full-jitter( fn ) ) per provider.
// Bottleneck limiter (per provider): bounds in-flight concurrency + min spacing so the worker fleet never exceeds the provider's RPM/concurrency ceiling, this prevents most 429s rather than reacting to them.
// withRetry: full-jitter, Retry-After-aware retry on 429/5xx (see resilient.call.js).
// Tunable via env: <PROVIDER>_MAX_CONCURRENT, <PROVIDER>_MIN_TIME_MS (e.g. GROQ_MAX_CONCURRENT=4), or the LLM_MAX_CONCURRENT default.
// NOTE: no circuit breaker or cross-provider failover yet: deferred, needs a cross-provider model mapping and careful timer lifecycle.

const Bottleneck = require('bottleneck');
const { withRetry } = require('./resilient.call');
const { minSpacingMs, maxConcurrent } = require('../../core/provider.limits');
const { createLogger } = require('../../core/logger');

const logger = createLogger('resilientInference');

const limiters = new Map();

function envNum(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** One limiter per model, because the ceilings are per model: on Groq the same key allows 6k tokens a minute on one model and 12k on another. */
function getLimiter(provider, model) {
    const key = `${provider}:${model || ''}`;
    if (!limiters.has(key)) {
        const P = String(provider || 'default').toUpperCase();
        limiters.set(key, new Bottleneck({
            maxConcurrent: envNum(`${P}_MAX_CONCURRENT`,
                envNum('LLM_MAX_CONCURRENT', maxConcurrent(provider, model) ?? 6)),
            // Spacing is what actually prevents a 429; it was 0 for every provider until the ceilings were recorded in core/provider.limits.json.
            minTime: envNum(`${P}_MIN_TIME_MS`, minSpacingMs(provider, model)),
        }));
    }
    return limiters.get(key);
}

/**
 * Runs `fn` for a provider through the concurrency limiter + jittered retry.
 * @param {string} provider e.g. 'groq' | 'cerebras' | 'gemini' | 'sarvam'
 * @param {() => Promise<any>} fn the actual SDK/network call
 * @param {Object} [retryOpts] forwarded to withRetry (maxRetries, baseDelayMs, …)
 * @param {string} [retryOpts.model] picks the model's limits out of provider.limits.json
 */
function runResilient(provider, fn, retryOpts = {}) {
    return getLimiter(provider, retryOpts.model).schedule(() =>
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

/** Releases limiter timers, call on graceful shutdown (and in test teardown). */
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
