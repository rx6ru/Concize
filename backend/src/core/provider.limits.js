// Reads provider.limits.json, the one place provider and model ceilings are recorded.
// Call this rather than hardcoding a number at a call site, every limit here was read off a response header or a quota violation (see _howToVerify in the JSON).

'use strict';

const table = require('./provider.limits.json');

// Keys beginning with _ are prose for whoever reads the file, not limits.
const isAnnotation = (key) => key.startsWith('_');

const strip = (obj = {}) => Object.fromEntries(
    Object.entries(obj).filter(([key]) => !isAnnotation(key))
);

/**
 * Every limit for one model: global defaults <- provider defaults <- model, most specific wins.
 * A limit that has not been established is null, never absent, so a caller can tell "no ceiling recorded" apart from "no ceiling".
 * @returns {{requestsPerMinute: ?number, requestsPerDay: ?number, tokensPerMinute: ?number, maxRequestTokens: ?number, maxConcurrent: ?number}}
 */
function limitsFor(provider, model) {
    const entry = table.providers[String(provider || '').toLowerCase()] || {};
    return {
        ...strip(table.defaults),
        ...strip(entry.defaults),
        ...strip(entry.models?.[model]),
    };
}

/** The largest prompt this model will accept in one call, or null if not established. */
function maxRequestTokens(provider, model) {
    return limitsFor(provider, model).maxRequestTokens ?? null;
}

/** Whether a prompt of this size can be sent at all. Unknown limit means yes: refusing to try teaches nothing, whereas a 413 records a real number. */
function fitsInOneRequest(provider, model, estimatedTokens) {
    const cap = maxRequestTokens(provider, model);
    return cap === null || estimatedTokens <= cap;
}

/**
 * How many tokens the prompt may actually use: the ceiling minus the answer allowance minus anything the caller still has to add.
 * The completion budget counts as part of the request, a 13-token prompt asking for 9000 completion tokens is billed as "Requested 9013" and rejected.
 * @returns {?number} null when no ceiling is recorded; 0 when the allowance alone already exceeds it (a misconfiguration, not a tight fit).
 */
function promptBudget(provider, model, { completionTokens = 0, reserve = 0 } = {}) {
    const cap = maxRequestTokens(provider, model);
    if (cap === null) return null;
    return Math.max(0, cap - completionTokens - reserve);
}

/** Minimum gap between requests, for a rate limiter. Derived only from a per-minute cap, a daily cap is a volume ceiling, not a pacing signal (spreading it evenly would put 86 seconds between calls on a 1000/day model, which isn't what it means). */
function minSpacingMs(provider, model) {
    const rpm = limitsFor(provider, model).requestsPerMinute;
    return rpm ? Math.ceil(60000 / rpm) : 0;
}

function maxConcurrent(provider, model) {
    return limitsFor(provider, model).maxConcurrent ?? null;
}

/** Model ids recorded for a provider. */
function knownModels(provider) {
    const entry = table.providers[String(provider || '').toLowerCase()] || {};
    return Object.keys(entry.models || {}).filter((key) => !isAnnotation(key));
}

module.exports = {
    limitsFor, maxRequestTokens, fitsInOneRequest, promptBudget, minSpacingMs, maxConcurrent, knownModels,
};
