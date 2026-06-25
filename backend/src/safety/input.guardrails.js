

/**
 * Input Guardrails - Lightweight pre-LLM validation
 * 
 * DESIGN PHILOSOPHY:
 * We intentionally DO NOT use banned keyword lists because:
 * - Meetings about LLM security would legitimately discuss "jailbreak", "prompt injection", etc.
 * - Keyword blocking creates false positives and frustrates users.
 * 
 * Instead, we rely on:
 * 1. Basic sanity checks (length, empty)
 * 2. Summary-based relevance filtering (see relevanceFilter.js)
 * 3. The hardened system prompt (instructs LLM to stay on topic)
 */

const MAX_INPUT_LENGTH = 10000;

/**
 * Validates user input before sending to LLM
 * @param {string} userInput - The user's query
 * @returns {Object} { valid: boolean, blocked: boolean, reason?: string, error?: object }
 */
function validate(userInput) {
    // Empty input check
    if (!userInput || typeof userInput !== 'string') {
        return {
            valid: false,
            blocked: true,
            reason: 'empty_input',
            error: { type: 'validation', message: 'Please enter a message.' }
        };
    }

    const trimmed = userInput.trim();
    if (trimmed.length === 0) {
        return {
            valid: false,
            blocked: true,
            reason: 'empty_input',
            error: { type: 'validation', message: 'Please enter a message.' }
        };
    }

    // Length check (prevent abuse/DoS)
    if (userInput.length > MAX_INPUT_LENGTH) {
        return {
            valid: false,
            blocked: true,
            reason: 'too_long',
            error: { type: 'validation', message: 'Your message is too long. Please keep it under 10,000 characters.' }
        };
    }

    // All checks passed
    return { valid: true, blocked: false };
}

module.exports = {
    validate,
    MAX_INPUT_LENGTH
};
