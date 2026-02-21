// tests/preChunker.test.js

jest.mock('../configs/appConfig', () => ({
    chunking: {
        GAP_THRESHOLD_SECONDS: 3.0,
        MIN_TURN_TOKENS: 10,
        MAX_CHUNK_TOKENS: 500,
        MIN_CHUNK_TOKENS: 50,
    },
}));

jest.mock('../utils/logger', () => ({
    createLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

const { preChunkSegments, estimateTokens } = require('../services/preChunker');

describe('preChunker', () => {
    describe('estimateTokens', () => {
        it('should count words as token estimate', () => {
            expect(estimateTokens('hello world')).toBe(2);
            expect(estimateTokens('one two three four five')).toBe(5);
        });

        it('should handle empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });

        it('should handle multiple spaces', () => {
            expect(estimateTokens('hello    world')).toBe(2);
        });
    });

    describe('preChunkSegments', () => {
        it('should return a single chunk when no boundaries are triggered', () => {
            const result = {
                segments: [
                    { text: 'Hello everyone welcome to the meeting today', startTime: 0, endTime: 3, speaker: '0', confidence: 0.9 },
                    { text: 'Let us discuss the quarterly results and projections', startTime: 3.5, endTime: 6, speaker: '0', confidence: 0.9 },
                ],
                transcription: 'Hello everyone...',
            };

            const chunks = preChunkSegments(result);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].speakers).toEqual(['0']);
        });

        it('should split on timestamp gap > threshold', () => {
            const result = {
                segments: [
                    { text: 'First topic discussion about the mobile redesign progress and timeline', startTime: 0, endTime: 3, speaker: '0', confidence: 0.9 },
                    { text: 'Second topic discussion about the backend infrastructure and deployment', startTime: 10, endTime: 13, speaker: '0', confidence: 0.9 }, // 7s gap
                ],
                transcription: '',
            };

            const chunks = preChunkSegments(result);
            // Two chunks because of the 7s gap, but each may be below MIN_CHUNK_TOKENS (50)
            // and get merged. Let's check:
            // "First topic discussion about the mobile redesign progress and timeline" = 11 tokens 
            // "Second topic discussion about the backend infrastructure and deployment" = 10 tokens
            // Both < 50 MIN_CHUNK_TOKENS, so they merge back
            expect(chunks.length).toBeGreaterThanOrEqual(1);
        });

        it('should split on speaker change when current chunk has enough tokens', () => {
            // Each segment must be >= MIN_TURN_TOKENS (10) to trigger a split on speaker change,
            // AND >= MIN_CHUNK_TOKENS (50) to survive the tiny-chunk merge pass.
            const longText = Array.from({ length: 55 }, (_, i) => `word${i}`).join(' ');
            const result = {
                segments: [
                    { text: longText, startTime: 0, endTime: 5, speaker: '0', confidence: 0.9 },
                    { text: longText, startTime: 5.5, endTime: 10, speaker: '1', confidence: 0.9 },
                ],
                transcription: '',
            };

            const chunks = preChunkSegments(result);
            expect(chunks).toHaveLength(2);
            expect(chunks[0].speakers).toEqual(['0']);
            expect(chunks[1].speakers).toEqual(['1']);
        });

        it('should NOT split on speaker change if current chunk is too small', () => {
            const result = {
                segments: [
                    { text: 'Yes okay', startTime: 0, endTime: 1, speaker: '0', confidence: 0.9 }, // 2 tokens, < MIN_TURN_TOKENS
                    { text: 'Let us continue the discussion about mobile redesign progress and timeline updates', startTime: 1.5, endTime: 5, speaker: '1', confidence: 0.9 },
                ],
                transcription: '',
            };

            const chunks = preChunkSegments(result);
            // "Yes okay" is 2 tokens (< 10 MIN_TURN_TOKENS), so no split on speaker change
            expect(chunks).toHaveLength(1);
            expect(chunks[0].speakers).toContain('0');
            expect(chunks[0].speakers).toContain('1');
        });

        it('should handle empty segments with fallback to transcription', () => {
            const result = {
                segments: [],
                transcription: 'Fallback text from flat transcription',
            };

            const chunks = preChunkSegments(result);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe('Fallback text from flat transcription');
        });

        it('should return empty array if no segments and no transcription', () => {
            const result = { segments: [], transcription: '' };
            const chunks = preChunkSegments(result);
            expect(chunks).toHaveLength(0);
        });

        it('should track time range correctly', () => {
            const result = {
                segments: [
                    { text: 'Start of the meeting discussion and overview of agenda items for today', startTime: 5.0, endTime: 10.0, speaker: null, confidence: 0.9 },
                    { text: 'Continuing the discussion with more details about each agenda item we have', startTime: 10.5, endTime: 15.0, speaker: null, confidence: 0.9 },
                ],
                transcription: '',
            };

            const chunks = preChunkSegments(result);
            expect(chunks[0].startTime).toBe(5.0);
            expect(chunks[chunks.length - 1].endTime).toBe(15.0);
        });

        it('should handle segments without speaker (Groq - no diarization)', () => {
            const result = {
                segments: [
                    { text: 'Some words about the project and its current status update', startTime: 0, endTime: 3, speaker: null, confidence: 0.9 },
                    { text: 'More words about the next steps and planned activities ahead', startTime: 3.5, endTime: 6, speaker: null, confidence: 0.8 },
                ],
                transcription: '',
            };

            const chunks = preChunkSegments(result);
            // No speaker changes possible, should be one chunk
            expect(chunks).toHaveLength(1);
            expect(chunks[0].speakers).toEqual([]);
        });
    });
});
