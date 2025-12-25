// utils/llmSecurity/index.js

/**
 * LLM Security Module - Re-exports all security components
 */

const inputGuardrails = require('./inputGuardrails');
const relevanceFilter = require('./relevanceFilter');
const outputGuardrails = require('./outputGuardrails');
const securityMonitor = require('./securityMonitor');

module.exports = {
    // Input validation
    validateInput: inputGuardrails.validate,

    // Relevance filtering
    isRelevantToMeeting: relevanceFilter.isRelevantToMeeting,

    // Output validation
    validateOutput: outputGuardrails.validate,
    validateChunk: outputGuardrails.validateChunk,
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
