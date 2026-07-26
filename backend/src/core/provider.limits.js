// Reads provider.limits.json, the one place provider and model ceilings are recorded.
//
// Call this rather than writing a number into a call site. Every limit in here was either read
// off a response header or a quota violation; see _howToVerify in the JSON for how to recheck one.
//
//   const { fitsInOneRequest } = require('../core/provider.limits');
//   if (!fitsInOneRequest('groq', model, estimatedTokens)) { ...retrieve instead of stuffing... }

'use strict';

const table = require('./provider.limits.json');

// Keys beginning with _ are prose for whoever reads the file, not limits.
const isAnnotation = (key) => key.startsWith('_');

const strip = (obj = {}) => Object.fromEntries(
    Object.entries(obj).filter(([key]) => !isAnnotation(key))
);

/**
 * Every limit that applies to one model, most specific winning.
 * global defaults <- provider defaults <- model.
 *
 * A limit that has not been established is null, never absent and never a guess, so a caller can
 * tell "no ceiling recorded" apart from "no ceiling".
 *
 * @param {string} provider e.g. 'groq'
 * @param {string} [model]
 * @returns {{requestsPerMinute: ?number, requestsPerDay: ?number, tokensPerMinute: ?number,
 *            maxRequestTokens: ?number, maxConcurrent: ?number}}
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

/**
 * Whether a prompt of this size can be sent at all.
 * Unknown limit means yes: refusing to try teaches nothing, whereas a 413 records a real number.
 */
function fitsInOneRequest(provider, model, estimatedTokens) {
    const cap = maxRequestTokens(provider, model);
    return cap === null || estimatedTokens <= cap;
}

/**
 * Minimum gap between requests, for a rate limiter.
 *
 * Derived only from a per-minute cap. A daily cap is a volume ceiling and spreading it evenly
 * would put 86 seconds between calls on a 1000/day model, which is not what it means.
 */
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
    limitsFor, maxRequestTokens, fitsInOneRequest, minSpacingMs, maxConcurrent, knownModels,
};
