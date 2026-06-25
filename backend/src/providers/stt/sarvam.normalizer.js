// Normalizes Sarvam Batch API output into the shared TranscriptionResult contract.

'use strict';

const { createLogger } = require('../../core/logger');

const logger = createLogger('sarvamNormalizer');

/**
 * Converts Sarvam's batch transcription output into the unified TranscriptionResult.
 * Prefers the diarized_transcript (has speaker IDs + timestamps) when available.
 * Falls back to the timestamps-only format, then to flat transcript.
 *
 * @param {Object} sarvamResponse - Raw Sarvam batch output
 * @returns {import('./transcriptionResult').TranscriptionResult}
 */
function normalizeSarvamResult(sarvamResponse) {
    const segments = [];

    // Prefer diarized transcript (has speaker_id + timestamps)
    if (sarvamResponse.diarized_transcript?.entries?.length > 0) {
        const entries = sarvamResponse.diarized_transcript.entries;

        for (const entry of entries) {
            const text = (entry.transcript || '').trim();
            if (!text) continue;

            segments.push({
                text,
                startTime: entry.start_time_seconds ?? 0,
                endTime: entry.end_time_seconds ?? 0,
                speaker: entry.speaker_id != null ? String(entry.speaker_id) : null,
                confidence: null, // Sarvam doesn't provide per-segment confidence
            });
        }

        logger.debug('Normalized from diarized_transcript', {
            entries: entries.length,
            keptSegments: segments.length,
            uniqueSpeakers: [...new Set(segments.map(s => s.speaker).filter(Boolean))].length,
        });

    } else if (sarvamResponse.timestamps?.words?.length > 0) {
        // Fallback: use timestamps (no speaker info)
        const { words, start_time_seconds, end_time_seconds } = sarvamResponse.timestamps;

        for (let i = 0; i < words.length; i++) {
            const text = (words[i] || '').trim();
            if (!text) continue;

            segments.push({
                text,
                startTime: start_time_seconds?.[i] ?? 0,
                endTime: end_time_seconds?.[i] ?? 0,
                speaker: null,
                confidence: null,
            });
        }

        logger.debug('Normalized from timestamps (no diarization)', {
            words: words.length,
            keptSegments: segments.length,
        });
    }

    // Build flat transcript from segments, or fall back to Sarvam's flat transcript
    const transcription = segments.length > 0
        ? segments.map(s => s.text).join(' ')
        : (sarvamResponse.transcript || '').trim();

    // If still no segments, create one from the flat transcript
    if (segments.length === 0 && transcription) {
        segments.push({
            text: transcription,
            startTime: 0,
            endTime: 0,
            speaker: null,
            confidence: null,
        });
        logger.warn('No structured data, fell back to flat transcript');
    }

    return {
        success: true,
        transcription,
        provider: 'sarvam',
        language: sarvamResponse.language_code || null,
        segments,
    };
}

module.exports = { normalizeSarvamResult };
