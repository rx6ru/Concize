// tests/clean.test.js

const mockCreate = jest.fn();

// Mock logger
jest.mock('../src/core/logger', () => ({
    createLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

// Mock inference provider — uses the shared mockCreate
jest.mock('../src/providers/llm/inference.provider', () => ({
    getCleanInference: jest.fn(() => ({
        client: {
            chat: { completions: { create: mockCreate } },
        },
        model: 'mock-model',
        taskConfig: { provider: 'groq', temperature: 1, maxTokens: 8192 },
    })),
}));

// Mock prompt registry
jest.mock('../prompts/registry', () => ({
    getPrompt: jest.fn(() => 'Mock System Prompt'),
}));

const { getPrompt } = require('../prompts/registry');
const { clean } = require('../src/summary/transcript.cleaner');

describe('cleanService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should use the prompt registry and return parsed narrative JSON', async () => {
        const mockResponse = [
            {
                summary: 'Test summary',
                narrative: 'The team discussed testing and agreed on a plan.',
                mentionedNames: ['Alice'],
            },
        ];

        mockCreate.mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        });

        const result = await clean('Raw text', { hasSpeakers: false, provider: 'groq' });

        expect(result).toHaveLength(1);
        expect(result[0].narrative).toBe('The team discussed testing and agreed on a plan.');
        expect(result[0].summary).toBe('Test summary');
        expect(result[0].mentionedNames).toEqual(['Alice']);
        expect(getPrompt).toHaveBeenCalledWith('clean', { hasSpeakers: false, provider: 'groq' });
    });

    it('should pass hasSpeakers context to prompt registry', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        summary: 'Speaker-aware test',
                        narrative: 'Rahul discussed the budget.',
                        mentionedNames: ['Rahul'],
                    }]),
                },
            }],
        });

        await clean('Speaker 0: Hello', { hasSpeakers: true, provider: 'sarvam' });

        expect(getPrompt).toHaveBeenCalledWith('clean', { hasSpeakers: true, provider: 'sarvam' });
    });

    it('should handle backward-compatible refined_text field', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        summary: 'Old format',
                        refined_text: '- Old style output',
                    }]),
                },
            }],
        });

        const result = await clean('Raw text');

        expect(result[0].narrative).toBe('- Old style output');
        expect(result[0].mentionedNames).toEqual([]);
    });

    it('should retry on invalid JSON responses', async () => {
        // First attempt: invalid JSON
        mockCreate
            .mockResolvedValueOnce({
                choices: [{ message: { content: 'not json at all' } }],
            })
            // Second attempt: valid JSON
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify([{
                            summary: 'Retried OK',
                            narrative: 'Good response after retry.',
                            mentionedNames: [],
                        }]),
                    },
                }],
            });

        const result = await clean('Raw text');
        expect(result[0].summary).toBe('Retried OK');
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });
});
