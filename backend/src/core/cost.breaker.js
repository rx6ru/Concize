// Turns usage.ledger.js's bookkeeping into an actual stop. Before that, remainingToday and
// spentToday had zero call sites: the ledger recorded spend but nothing ever refused a call
// because of it. This does.
//
// Trips on whichever ceiling is tighter: the vendor's own tokensPerDay/requestsPerDay cap
// (provider.limits.json, real numbers read off response headers or 429 bodies) or an optional
// operator override (COST_CEILING_TOKENS_PER_DAY). A model with no recorded vendor cap and no
// override never trips: an unestablished limit means "not established", not "zero left" (same
// rule provider.limits.js already uses for fitsInOneRequest).

'use strict';

const { ledger: defaultLedger } = require('./usage.ledger');

/**
 * @param {string} provider
 * @param {string} model
 * @param {object} [opts]
 * @param {object} [opts.ledger]           injectable ledger (default: shared instance)
 * @param {?number} [opts.ceilingTokens]   optional operator override, tokens/day
 * @returns {boolean} true when today's spend for this provider/model is at or over its cap
 */
function isOverBudget(provider, model, { ledger = defaultLedger, ceilingTokens = null } = {}) {
    const remaining = ledger.remainingToday(provider, model);

    if (remaining.tokens !== null && remaining.tokens <= 0) return true;
    if (remaining.requests !== null && remaining.requests <= 0) return true;
    if (ceilingTokens !== null && remaining.spent.tokens >= ceilingTokens) return true;

    return false;
}

module.exports = { isOverBudget };
