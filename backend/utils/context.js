// utils/context.js
//
// Per-request context propagated implicitly through the async call chain via AsyncLocalStorage —
// no need to thread a requestId argument through every function. The logger reads from here to tag
// every log line, so one id traces a request across all modules. (Node 18+ built-in; no deps.)

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/** Runs `fn` with `ctx` (e.g. { requestId }) as the ambient context for all downstream awaits. */
function runWithContext(ctx, fn) {
    return als.run(ctx, fn);
}

/** The current context object, or undefined if not inside a runWithContext scope. */
function getContext() {
    return als.getStore();
}

/** Convenience: the current requestId, or undefined. */
function getRequestId() {
    const store = als.getStore();
    return store && store.requestId;
}

module.exports = { als, runWithContext, getContext, getRequestId };
