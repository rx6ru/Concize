// What has been spent against today's provider caps.
//
// The daily caps are the ones that actually bite (tokens/day on Groq, requests/day on Gemini
// embeddings), and no provider reports how much is left — you find out from a 429, by which point
// the day is gone. Recording spend locally is the only way to know before starting work whether
// it can finish.
//
// Append-only JSONL because more than one process spends against the same budget: the backend
// during a meeting, the evaluation harness during a run. A single-line append is atomic enough
// for that; nothing here rewrites earlier lines.
//
// Worth knowing what this measures: on 2026-08-09 an evaluation run accounted for 39k of the 196k
// spent on gpt-oss-120b that day. The rest was layer-2 narration on the write path. The expensive
// thing was not the thing being measured.

'use strict';

const fs = require('fs');
const path = require('path');
const { limitsFor } = require('./provider.limits');
const { createLogger } = require('./logger');

const logger = createLogger('usageLedger');

const DEFAULT_FILE = path.join(process.env.USAGE_LEDGER_DIR || '/tmp', 'concize-usage.jsonl');

const isoDay = () => new Date().toISOString().slice(0, 10);

/**
 * @param {object} [deps]
 * @param {string} [deps.file]    where the ledger lives
 * @param {function} [deps.today] returns the current day as YYYY-MM-DD; injectable for tests
 */
function createUsageLedger({ file = DEFAULT_FILE, today = isoDay } = {}) {

    function totals(provider, model) {
        const day = today();
        let tokens = 0;
        let requests = 0;

        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch {
            return { tokens, requests };   // no ledger yet is not an error
        }

        for (const line of raw.split('\n')) {
            if (!line) continue;
            let row;
            // A truncated final line from a killed process must not lose the rest of the day.
            try { row = JSON.parse(line); } catch { continue; }
            if (row.day !== day || row.provider !== provider || row.model !== model) continue;
            tokens += row.tokens || 0;
            requests += row.requests || 1;
        }
        return { tokens, requests };
    }

    return {
        /** Records one call. `tokens` may be 0 for providers that meter requests instead. */
        record(provider, model, tokens = 0) {
            const row = { day: today(), provider, model, tokens, requests: 1, at: new Date().toISOString() };
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
            } catch (err) {
                // Accounting must never take down the thing it is accounting for.
                logger.warn('Could not record usage', { provider, model, error: err.message });
            }
        },

        spentToday(provider, model) {
            return totals(provider, model).tokens;
        },

        requestsToday(provider, model) {
            return totals(provider, model).requests;
        },

        /**
         * What is left of today's caps.
         * A null means no cap is recorded for that model — not that nothing is left.
         */
        remainingToday(provider, model) {
            const { tokens, requests } = totals(provider, model);
            const limits = limitsFor(provider, model);
            const left = (cap, used) => (cap == null ? null : Math.max(0, cap - used));
            return {
                tokens: left(limits.tokensPerDay, tokens),
                requests: left(limits.requestsPerDay, requests),
                spent: { tokens, requests },
            };
        },
    };
}

// Shared instance for the app; tests build their own against a temp file.
const ledger = createUsageLedger();

module.exports = { createUsageLedger, ledger };
