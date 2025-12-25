// utils/llmSecurity/outputGuardrails.js

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
    validateChunk,
    SAFE_FALLBACK
};
