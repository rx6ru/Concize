

/**
 * LLM Security Module - Re-exports all security components
 */

const inputGuardrails = require('./input.guardrails');
const relevanceFilter = require('./relevance.filter');
const outputGuardrails = require('./output.guardrails');
const securityMonitor = require('./security.monitor');

module.exports = {
    // Input validation
    validateInput: inputGuardrails.validate,

    // Relevance filtering
    isRelevantToMeeting: relevanceFilter.isRelevantToMeeting,

    // Output validation
    validateOutput: outputGuardrails.validate,
    validateChunk: outputGuardrails.validateChunk,
    createStreamGuard: outputGuardrails.createStreamGuard,
    SAFE_FALLBACK: outputGuardrails.SAFE_FALLBACK,

    // Security monitoring
    recordViolation: securityMonitor.recordViolation,
    checkBlocked: securityMonitor.checkBlocked,

    // Full module exports for testing
    inputGuardrails,
    relevanceFilter,
    outputGuardrails,
    securityMonitor
};
