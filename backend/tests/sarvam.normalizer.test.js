// tests/sarvamNormalizer.test.js

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

const { normalizeSarvamResult } = require('../src/providers/stt/sarvam.normalizer');

describe('sarvamNormalizer', () => {
    it('should normalize diarized transcript with speaker IDs', () => {
        const sarvamResponse = {
            transcript: 'Hello, how can I help you today? I have a question.',
            diarized_transcript: {
                entries: [
                    {
                        transcript: 'Hello, how can I help you today?',
                        start_time_seconds: 0.01,
                        end_time_seconds: 2.5,
                        speaker_id: '0',
                    },
                    {
                        transcript: 'I have a question.',
                        start_time_seconds: 2.8,
                        end_time_seconds: 4.2,
                        speaker_id: '1',
                    },
                ],
            },
            language_code: 'en-IN',
        };

        const result = normalizeSarvamResult(sarvamResponse);

        expect(result.success).toBe(true);
        expect(result.provider).toBe('sarvam');
        expect(result.language).toBe('en-IN');
        expect(result.segments).toHaveLength(2);
        expect(result.segments[0].text).toBe('Hello, how can I help you today?');
        expect(result.segments[0].speaker).toBe('0');
        expect(result.segments[0].startTime).toBe(0.01);
        expect(result.segments[1].speaker).toBe('1');
        expect(result.transcription).toBe('Hello, how can I help you today? I have a question.');
    });

    it('should fall back to timestamps when no diarization', () => {
        const sarvamResponse = {
            transcript: 'Hello world',
            timestamps: {
                words: ['Hello', 'world'],
                start_time_seconds: [0.0, 0.5],
                end_time_seconds: [0.5, 1.0],
            },
            language_code: 'hi-IN',
        };

        const result = normalizeSarvamResult(sarvamResponse);

        expect(result.success).toBe(true);
        expect(result.segments).toHaveLength(2);
        expect(result.segments[0].speaker).toBeNull(); // no speaker info
        expect(result.segments[0].text).toBe('Hello');
        expect(result.language).toBe('hi-IN');
    });

    it('should fall back to flat transcript when no structured data', () => {
        const sarvamResponse = {
            transcript: 'Some raw text without structure',
            language_code: 'en-IN',
        };

        const result = normalizeSarvamResult(sarvamResponse);

        expect(result.success).toBe(true);
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0].text).toBe('Some raw text without structure');
        expect(result.segments[0].speaker).toBeNull();
    });

    it('should handle empty diarized entries', () => {
        const sarvamResponse = {
            transcript: 'Fallback text',
            diarized_transcript: { entries: [] },
        };

        const result = normalizeSarvamResult(sarvamResponse);

        expect(result.success).toBe(true);
        // Should fall through to flat transcript since entries is empty
        expect(result.segments).toHaveLength(1);
        expect(result.transcription).toBe('Fallback text');
    });

    it('should skip empty transcript entries', () => {
        const sarvamResponse = {
            diarized_transcript: {
                entries: [
                    { transcript: '', start_time_seconds: 0, end_time_seconds: 1, speaker_id: '0' },
                    { transcript: 'Real content', start_time_seconds: 1, end_time_seconds: 3, speaker_id: '1' },
                ],
            },
        };

        const result = normalizeSarvamResult(sarvamResponse);
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0].text).toBe('Real content');
    });

    it('should handle null language_code', () => {
        const sarvamResponse = {
            transcript: 'Test',
        };

        const result = normalizeSarvamResult(sarvamResponse);
        expect(result.language).toBeNull();
    });

    it('should handle numeric speaker_id by converting to string', () => {
        const sarvamResponse = {
            diarized_transcript: {
                entries: [
                    { transcript: 'Test', start_time_seconds: 0, end_time_seconds: 1, speaker_id: 2 },
                ],
            },
        };

        const result = normalizeSarvamResult(sarvamResponse);
        expect(result.segments[0].speaker).toBe('2');
    });
});
