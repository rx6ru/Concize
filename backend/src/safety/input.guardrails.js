

/**
 * Input guardrails: lightweight pre-LLM validation.
 * Deliberately no banned-keyword list: meetings about LLM security legitimately discuss "jailbreak", "prompt injection", etc, and keyword blocking creates false positives.
 * Relies instead on basic sanity checks here, summary-based relevance filtering (relevance.filter.js), and the hardened system prompt.
 */

const MAX_INPUT_LENGTH = 10000;

/**
 * Validates user input before sending to LLM
 * @param {string} userInput - The user's query
 * @returns {Object} { valid: boolean, blocked: boolean, reason?: string, error?: object }
 */
function validate(userInput) {
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

    // Prevents abuse/DoS.
    if (userInput.length > MAX_INPUT_LENGTH) {
        return {
            valid: false,
            blocked: true,
            reason: 'too_long',
            error: { type: 'validation', message: 'Your message is too long. Please keep it under 10,000 characters.' }
        };
    }

    return { valid: true, blocked: false };
}

module.exports = {
    validate,
    MAX_INPUT_LENGTH
};
