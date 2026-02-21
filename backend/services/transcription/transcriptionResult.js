// services/transcription/transcriptionResult.js
// Shared TranscriptionResult contract — all providers must normalize to this shape.

'use strict';

/**
 * @typedef {Object} TranscriptionSegment
 * @property {string} text - The transcribed text for this segment
 * @property {number} startTime - Start time in seconds
 * @property {number} endTime - End time in seconds
 * @property {string|null} speaker - Speaker ID (null if provider has no diarization)
 * @property {number|null} confidence - Confidence score 0-1 (null if unavailable)
 */

/**
 * @typedef {Object} TranscriptionResult
 * @property {boolean} success - Whether transcription succeeded
 * @property {string} transcription - Flat text string (backward compat)
 * @property {string} provider - Provider name ('groq' | 'sarvam')
 * @property {string|null} language - Detected or configured language code
 * @property {TranscriptionSegment[]} segments - Structured segment data
 * @property {string} [error] - Error message if success is false
 */

/**
 * Validates a TranscriptionResult has the required shape.
 * Does not throw — returns { valid, errors }.
 * @param {Object} result
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateResult(result) {
    const errors = [];

    if (typeof result !== 'object' || result === null) {
        return { valid: false, errors: ['Result must be a non-null object'] };
    }

    if (typeof result.success !== 'boolean') {
        errors.push('result.success must be a boolean');
    }

    // If failure, only success + error are required
    if (result.success === false) {
        if (typeof result.error !== 'string' || !result.error) {
            errors.push('Failed result must have an error string');
        }
        return { valid: errors.length === 0, errors };
    }

    // Success case: validate full shape
    if (typeof result.transcription !== 'string') {
        errors.push('result.transcription must be a string');
    }

    if (!['groq', 'sarvam'].includes(result.provider)) {
        errors.push(`result.provider must be 'groq' or 'sarvam', got: ${result.provider}`);
    }

    if (!Array.isArray(result.segments)) {
        errors.push('result.segments must be an array');
    } else {
        for (let i = 0; i < Math.min(result.segments.length, 3); i++) {
            const seg = result.segments[i];
            if (typeof seg.text !== 'string') errors.push(`segment[${i}].text must be a string`);
            if (typeof seg.startTime !== 'number') errors.push(`segment[${i}].startTime must be a number`);
            if (typeof seg.endTime !== 'number') errors.push(`segment[${i}].endTime must be a number`);
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Creates a failed TranscriptionResult.
 * @param {string} provider
 * @param {string} errorMessage
 * @returns {TranscriptionResult}
 */
function createFailureResult(provider, errorMessage) {
    return {
        success: false,
        transcription: '',
        provider,
        language: null,
        segments: [],
        error: errorMessage,
    };
}

module.exports = { validateResult, createFailureResult };
