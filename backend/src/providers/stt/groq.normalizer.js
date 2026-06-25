// Normalizes Groq's verbose_json response into the shared TranscriptionResult contract.

'use strict';

const config = require('../../core/config');
const { createLogger } = require('../../core/logger');

const logger = createLogger('groqNormalizer');

/**
 * Converts Groq's avg_logprob (log probability, negative) to a 0-1 confidence score.
 * avg_logprob = 0 → confidence 1.0 (perfect)
 * avg_logprob = -0.5 → confidence ~0.61
 * avg_logprob = -2.0 → confidence ~0.14
 * @param {number|undefined} avgLogprob
 * @returns {number|null}
 */
function logprobToConfidence(avgLogprob) {
    if (avgLogprob == null || typeof avgLogprob !== 'number') return null;
    return Math.exp(avgLogprob); // e^logprob gives 0-1 range
}

/**
 * Filters and normalizes Groq verbose_json segments into TranscriptionResult segments.
 * Applies silence and confidence filtering using configurable thresholds.
 *
 * @param {Object} groqResponse - Raw Groq verbose_json response
 * @returns {import('./transcriptionResult').TranscriptionResult}
 */
function normalizeGroqResult(groqResponse) {
    const { silenceThreshold, confidenceFloor } = config.inference.transcriptionFilters;

    const rawSegments = groqResponse.segments || [];
    let filteredCount = 0;

    const segments = [];
    for (const seg of rawSegments) {
        // Filter silence
        if (seg.no_speech_prob != null && seg.no_speech_prob > silenceThreshold) {
            filteredCount++;
            continue;
        }

        // Filter garbled audio (low confidence)
        if (seg.avg_logprob != null && seg.avg_logprob < confidenceFloor) {
            filteredCount++;
            continue;
        }

        // Skip empty text segments
        const text = (seg.text || '').trim();
        if (!text) {
            filteredCount++;
            continue;
        }

        segments.push({
            text,
            startTime: seg.start ?? 0,
            endTime: seg.end ?? 0,
            speaker: null, // Groq does not support diarization
            confidence: logprobToConfidence(seg.avg_logprob),
        });
    }

    if (filteredCount > 0) {
        logger.debug('Filtered low-quality segments', {
            total: rawSegments.length,
            filtered: filteredCount,
            kept: segments.length,
        });
    }

    // Build flat text from kept segments (backward compat)
    const transcription = segments.map(s => s.text).join(' ');

    return {
        success: true,
        transcription,
        provider: 'groq',
        language: groqResponse.language || null,
        segments,
    };
}

module.exports = { normalizeGroqResult, logprobToConfidence };
