// Labels for the codes the chat endpoint sends (backend/src/chat/chat.controller.js).
//
// mapErrorToResponse there (chat.controller.js:35-105) always returns a { status, code, message }
// triple, and the pre-stream JSON error path (:143-161, :228-234, :403-409) and the mid-stream SSE
// "event: error" payload (:416-417) both carry that code. Before this, chat-popup.js read only
// `.message` and, on the SSE path, printed a fixed "Connection Lost:" label regardless of what
// actually happened — a rate limit and a dropped connection looked identical. This gives each known
// code a short, distinct label so the two are visibly different; the message text still carries the
// specific explanation.
//
// RETRIEVAL_UNAVAILABLE is listed here for when it is reachable, but as of this writing it is not:
// buildContext (backend/src/chat/retrieval.wiring.js:98) sets err.code = 'RETRIEVAL_UNAVAILABLE',
// yet mapErrorToResponse has no branch for it and does not pass an unrecognized error.code through,
// so that error falls to its default case and reaches the client as INTERNAL_SERVER_ERROR instead.

(function (root) {
    const LABELS = {
        RATE_LIMIT_EXCEEDED: 'Busy',
        UNAUTHORIZED: 'Session',
        SERVICE_TIMEOUT: 'Connection',
        TEMPORARILY_BLOCKED: 'Blocked',
        PROMPT_INJECTION: 'Blocked',
        QUERY_NOT_RELEVANT: 'Off-topic',
        RETRIEVAL_UNAVAILABLE: 'Search Down',
        INTERNAL_SERVER_ERROR: 'Error',
    };

    function labelForCode(code, fallback = 'Error') {
        return LABELS[code] || fallback;
    }

    const api = { labelForCode };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) Object.assign(root, { ConcizeChatErrors: api });
}(typeof self !== 'undefined' ? self : null));
