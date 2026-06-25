// tests/groqNormalizer.test.js

jest.mock('../src/core/config', () => ({
    inference: {
        transcriptionFilters: {
            silenceThreshold: 0.5,
            confidenceFloor: -0.5,
        },
    },
}));

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

const { normalizeGroqResult, logprobToConfidence } = require('../src/providers/stt/groq.normalizer');

describe('groqNormalizer', () => {
    describe('logprobToConfidence', () => {
        it('should convert 0 logprob to confidence 1.0', () => {
            expect(logprobToConfidence(0)).toBeCloseTo(1.0);
        });

        it('should convert -0.5 logprob to ~0.61', () => {
            expect(logprobToConfidence(-0.5)).toBeCloseTo(0.6065, 3);
        });

        it('should return null for undefined input', () => {
            expect(logprobToConfidence(undefined)).toBeNull();
        });

        it('should return null for null input', () => {
            expect(logprobToConfidence(null)).toBeNull();
        });
    });

    describe('normalizeGroqResult', () => {
        it('should normalize a basic verbose_json response', () => {
            const groqResponse = {
                text: 'Hello world',
                language: 'en',
                segments: [
                    { start: 0.0, end: 2.5, text: 'Hello', avg_logprob: -0.05, no_speech_prob: 0.01 },
                    { start: 2.5, end: 5.0, text: 'world', avg_logprob: -0.1, no_speech_prob: 0.02 },
                ],
            };

            const result = normalizeGroqResult(groqResponse);

            expect(result.success).toBe(true);
            expect(result.provider).toBe('groq');
            expect(result.language).toBe('en');
            expect(result.segments).toHaveLength(2);
            expect(result.segments[0].text).toBe('Hello');
            expect(result.segments[0].startTime).toBe(0.0);
            expect(result.segments[0].endTime).toBe(2.5);
            expect(result.segments[0].speaker).toBeNull();
            expect(result.segments[0].confidence).toBeCloseTo(0.951, 2);
            expect(result.transcription).toBe('Hello world');
        });

        it('should filter silence segments (no_speech_prob > threshold)', () => {
            const groqResponse = {
                segments: [
                    { start: 0, end: 2, text: 'Hello', avg_logprob: -0.05, no_speech_prob: 0.01 },
                    { start: 2, end: 4, text: '', avg_logprob: -0.9, no_speech_prob: 0.89 }, // silence
                    { start: 4, end: 6, text: 'World', avg_logprob: -0.1, no_speech_prob: 0.02 },
                ],
            };

            const result = normalizeGroqResult(groqResponse);
            expect(result.segments).toHaveLength(2);
            expect(result.segments[0].text).toBe('Hello');
            expect(result.segments[1].text).toBe('World');
        });

        it('should filter low-confidence segments (avg_logprob < confidenceFloor)', () => {
            const groqResponse = {
                segments: [
                    { start: 0, end: 2, text: 'Clear audio', avg_logprob: -0.1, no_speech_prob: 0.01 },
                    { start: 2, end: 4, text: 'Garbled mess', avg_logprob: -0.8, no_speech_prob: 0.1 }, // low confidence
                ],
            };

            const result = normalizeGroqResult(groqResponse);
            expect(result.segments).toHaveLength(1);
            expect(result.segments[0].text).toBe('Clear audio');
        });

        it('should handle empty segments array', () => {
            const result = normalizeGroqResult({ segments: [] });
            expect(result.success).toBe(true);
            expect(result.segments).toHaveLength(0);
            expect(result.transcription).toBe('');
        });

        it('should handle missing segments property', () => {
            const result = normalizeGroqResult({ text: 'fallback' });
            expect(result.success).toBe(true);
            expect(result.segments).toHaveLength(0);
        });

        it('should skip segments with empty text', () => {
            const groqResponse = {
                segments: [
                    { start: 0, end: 2, text: '   ', avg_logprob: -0.1, no_speech_prob: 0.01 },
                    { start: 2, end: 4, text: 'Actual content', avg_logprob: -0.1, no_speech_prob: 0.01 },
                ],
            };

            const result = normalizeGroqResult(groqResponse);
            expect(result.segments).toHaveLength(1);
            expect(result.segments[0].text).toBe('Actual content');
        });

        it('should handle null language', () => {
            const result = normalizeGroqResult({ segments: [] });
            expect(result.language).toBeNull();
        });
    });
});
