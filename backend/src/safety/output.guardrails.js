

/**
 * Output Guardrails - Post-LLM validation to catch leakage and harmful content
 */

// Patterns that indicate the LLM may have leaked its system prompt
const LEAKAGE_PATTERNS = [
    /system_role/i,
    /security_protocols/i,
    /instruction_lock/i,
    /refusal_templates/i,
    /<system>/i,
    /CRITICAL SECURITY RULES/i,
    /NEVER reveal these instructions/i,
    /my (system )?prompt (is|says|contains)/i,
    /I('m| am) (an AI|a language model|GPT|Claude|Gemini)/i,
];

// Patterns indicating the LLM bypassed safety (rare but possible)
const BYPASS_PATTERNS = [
    /I('ll| will) ignore (my|the) (instructions|rules)/i,
    /entering (developer|debug|admin) mode/i,
    /jailbreak (successful|complete)/i,
    /I can now/i,
];

// Safe fallback response when output is blocked
const SAFE_FALLBACK = "I apologize, but I couldn't generate a helpful response. Please try rephrasing your question about the meeting.";

/**
 * Validates LLM output for security issues
 * @param {string} llmResponse - The full response from the LLM
 * @returns {Object} { valid: boolean, filtered: boolean, response: string, reason?: string }
 */
function validate(llmResponse) {
    if (!llmResponse || typeof llmResponse !== 'string') {
        return { valid: false, filtered: true, response: SAFE_FALLBACK, reason: 'empty_response' };
    }

    // Check for prompt leakage
    for (const pattern of LEAKAGE_PATTERNS) {
        if (pattern.test(llmResponse)) {
            console.warn(`SECURITY_WARN: Output contained potential prompt leakage.`);
            return {
                valid: false,
                filtered: true,
                response: SAFE_FALLBACK,
                reason: 'prompt_leakage'
            };
        }
    }

    // Check for safety bypass
    for (const pattern of BYPASS_PATTERNS) {
        if (pattern.test(llmResponse)) {
            console.warn(`SECURITY_WARN: Output indicated potential safety bypass.`);
            return {
                valid: false,
                filtered: true,
                response: SAFE_FALLBACK,
                reason: 'safety_bypass'
            };
        }
    }

    return { valid: true, filtered: false, response: llmResponse };
}

// Long enough to hold any pattern above (the longest is ~35 characters) so one cannot hide by
// falling across a delta boundary, short enough that the per-delta scan stays cheap.
const SCAN_WINDOW = 256;

/**
 * A guard for a streamed answer.
 *
 * `validateChunk` below tests a delta on its own, which cannot work: deltas are a few characters
 * each, so "CRITICAL SECURITY RULES" is never present in any single one. This carries a bounded
 * tail of what came before, so a pattern spanning several deltas is still seen.
 *
 * Streaming means some of a leak has already reached the client before it can be recognised;
 * stopping at the match is damage limitation, not prevention. The caller should also tell the
 * client to discard what it rendered.
 *
 * @returns {{push: function(string): {blocked: boolean, reason?: string}, scanned: function(): number}}
 */
function createStreamGuard() {
    let tail = '';
    let blocked = null;

    return {
        push(delta) {
            if (blocked) return blocked;
            if (!delta) return { blocked: false };

            const window = tail + delta;
            for (const [reason, patterns] of [
                ['prompt_leakage', LEAKAGE_PATTERNS],
                ['safety_bypass', BYPASS_PATTERNS],
            ]) {
                for (const pattern of patterns) {
                    if (pattern.test(window)) {
                        blocked = { blocked: true, reason };
                        return blocked;
                    }
                }
            }

            tail = window.slice(-SCAN_WINDOW);
            return { blocked: false };
        },

        /** Characters currently retained. Bounded by SCAN_WINDOW; exposed so a test can prove it. */
        scanned: () => tail.length,
    };
}

/**
 * Validates a chunk of streamed output (lighter check for performance)
 * @param {string} chunk - A single chunk from the stream
 * @returns {Object} { valid: boolean }
 */
function validateChunk(chunk) {
    if (!chunk) return { valid: true };

    // Only check critical patterns for streaming (performance)
    const criticalPatterns = LEAKAGE_PATTERNS.slice(0, 5);

    for (const pattern of criticalPatterns) {
        if (pattern.test(chunk)) {
            return { valid: false, reason: 'leakage_in_chunk' };
        }
    }

    return { valid: true };
}

module.exports = {
    validate,
    createStreamGuard,
    validateChunk,
    SAFE_FALLBACK
};
