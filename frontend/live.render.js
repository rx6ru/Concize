// What to show while the words are still arriving.
//
// The words lane emits a partial roughly every 400ms and a final only when an utterance closes,
// which measured at a 6.1 second median and 14 seconds at p90. Showing finals alone leaves the
// popup blank for that whole stretch while the system already has the text, so a partial holds
// one provisional line until its final replaces it.
//
// The backend sends partials for exactly this purpose (gateway.js: "just there to make the
// overlay feel live until the final replaces them") and strips their speaker, since attribution
// is not settled yet.

(function (root) {
    /** Tracks the one provisional line. Returns the text to display, or null to clear it. */
    function partialTracker() {
        const state = { pending: null };

        return {
            get pending() { return state.pending; },

            onPartial(msg) {
                const text = String((msg && msg.text) || '').trim();
                // A momentary empty partial should not blank a line that already reads well.
                if (!text) return state.pending;
                state.pending = text;
                return state.pending;
            },

            // The final supersedes the provisional line. Deliberately no staleness guard: a
            // partial arriving just after its own final is indistinguishable from the first
            // partial of the next utterance, and suppressing the second would leave a meeting
            // with no live text after its opening turn.
            onFinal() {
                state.pending = null;
                return null;
            },
        };
    }

    const api = { partialTracker };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) Object.assign(root, { ConcizeLiveRender: api });
}(typeof self !== 'undefined' ? self : null));
