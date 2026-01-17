// tests/clean.test.js

const { clean } = require('../controllers/clean');

// Mock groqService
jest.mock('../utils/llm/groqService', () => ({
    getClient: jest.fn(),
}));

// Mock config
jest.mock('../utils/config', () => ({
    GROQ_API_KEYS: ['mock-key'],
}));

const groqService = require('../utils/llm/groqService');

describe('clean() Function', () => {
    let mockGroqClient;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup default mock Groq client
        mockGroqClient = {
            chat: {
                completions: {
                    create: jest.fn(),
                },
            },
        };
        
        groqService.getClient.mockReturnValue(mockGroqClient);
    });

    describe('Happy Path - Successful Cleaning', () => {
        it('should successfully clean and parse valid transcription on first attempt', async () => {
            const rawText = 'Um, so like, you know, AI is really cool and stuff.';
            const expectedJson = [
                {
                    summary: 'Discussion about AI being cool.',
                    refined_text: '- AI is really cool.\\n',
                },
            ];

            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [
                    {
                        message: {
                            content: JSON.stringify(expectedJson),
                        },
                    },
                ],
            });

            const result = await clean(rawText);

            expect(result).toEqual(expectedJson);
            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(1);
        });

        it('should extract JSON from response with surrounding text', async () => {
            const rawText = 'Test transcription';
            const expectedJson = [
                { summary: 'Test', refined_text: '- Test\\n' },
            ];
            const responseWithExtra = `Here is the JSON:\n${JSON.stringify(expectedJson)}\nThat's it!`;

            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: responseWithExtra } }],
            });

            const result = await clean(rawText);

            expect(result).toEqual(expectedJson);
        });

        it('should extract JSON array with code block markers', async () => {
            const rawText = 'Test transcription';
            const expectedJson = [
                { summary: 'Test', refined_text: '- Test\\n' },
            ];
            const responseWithCodeBlock = `\`\`\`json\n${JSON.stringify(expectedJson)}\n\`\`\``;

            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: responseWithCodeBlock } }],
            });

            const result = await clean(rawText);

            expect(result).toEqual(expectedJson);
        });

        it('should handle multiple chunks in response', async () => {
            const rawText = 'Long meeting transcription...';
            const expectedJson = [
                { summary: 'Introduction', refined_text: '- Hello everyone\\n' },
                { summary: 'Main topic', refined_text: '- Let\'s discuss AI\\n' },
                { summary: 'Conclusion', refined_text: '- Thank you\\n' },
            ];

            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: JSON.stringify(expectedJson) } }],
            });

            const result = await clean(rawText);

            expect(result).toEqual(expectedJson);
            expect(result.length).toBe(3);
        });
    });

    describe('Retry Mechanism', () => {
        it('should retry up to 3 times on failure', async () => {
            const rawText = 'Test text';

            mockGroqClient.chat.completions.create
                .mockRejectedValueOnce(new Error('API Error'))
                .mockRejectedValueOnce(new Error('API Error'))
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify([{ summary: 'Success', refined_text: '- Success\\n' }]),
                            },
                        },
                    ],
                });

            const result = await clean(rawText);

            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(3);
            expect(result).toHaveLength(1);
        });

        it('should retry when no valid JSON array found', async () => {
            const rawText = 'Test text';

            mockGroqClient.chat.completions.create
                .mockResolvedValueOnce({
                    choices: [{ message: { content: 'Invalid response without JSON' } }],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify([{ summary: 'Valid', refined_text: '- Valid\\n' }]),
                            },
                        },
                    ],
                });

            const result = await clean(rawText);

            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(2);
            expect(result).toEqual([{ summary: 'Valid', refined_text: '- Valid\\n' }]);
        });

        it('should throw error after 3 failed attempts', async () => {
            const rawText = 'Test text';
            const apiError = new Error('Persistent API Error');

            mockGroqClient.chat.completions.create.mockRejectedValue(apiError);

            await expect(clean(rawText)).rejects.toThrow('Persistent API Error');
            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(3);
        });

        it('should throw error after 3 attempts with invalid responses', async () => {
            const rawText = 'Test text';

            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: 'No JSON here at all' } }],
            });

            await expect(clean(rawText)).rejects.toThrow('Failed to clean transcription after multiple attempts.');
            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(3);
        });
    });

    describe('API Request Configuration', () => {
        it('should call Groq API with correct parameters', async () => {
            const rawText = 'Test input';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"Test","refined_text":"- Test\\n"}]' } }],
            });

            await clean(rawText);

            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({ role: 'system' }),
                        expect.objectContaining({ role: 'user', content: rawText }),
                    ]),
                    model: 'openai/gpt-oss-120b',
                    temperature: 1,
                    max_completion_tokens: 8192,
                    top_p: 1,
                    stream: false,
                    reasoning_effort: 'medium',
                    stop: null,
                })
            );
        });

        it('should use groqService.getClient() for key rotation', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"T","refined_text":"- T\\n"}]' } }],
            });

            await clean(rawText);

            expect(groqService.getClient).toHaveBeenCalledTimes(1);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty choices array', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [],
            });

            await expect(clean(rawText)).rejects.toThrow();
        });

        it('should handle undefined message content', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: {} }],
            });

            await expect(clean(rawText)).rejects.toThrow();
        });

        it('should handle malformed JSON in response', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create
                .mockResolvedValueOnce({
                    choices: [{ message: { content: '[{invalid json}]' } }],
                })
                .mockResolvedValueOnce({
                    choices: [{ message: { content: '[{"summary":"OK","refined_text":"- OK\\n"}]' } }],
                });

            const result = await clean(rawText);
            expect(result).toBeDefined();
        });

        it('should handle empty JSON array', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[]' } }],
            });

            const result = await clean(rawText);
            expect(result).toEqual([]);
        });

        it('should handle nested arrays in response', async () => {
            const rawText = 'Test';
            const nestedResponse = '[[{"summary":"Nested","refined_text":"- Nested\\n"}]]';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: nestedResponse } }],
            });

            const result = await clean(rawText);
            // Should extract the outer array
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Input Validation', () => {
        it('should process very long transcription text', async () => {
            const longText = 'A'.repeat(10000);
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"Long","refined_text":"- Long\\n"}]' } }],
            });

            const result = await clean(longText);

            expect(result).toBeDefined();
            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({ content: longText }),
                    ]),
                })
            );
        });

        it('should handle special characters in input', async () => {
            const specialText = 'Test with "quotes" and \'apostrophes\' and \\backslashes\\';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"Special","refined_text":"- Special\\n"}]' } }],
            });

            const result = await clean(specialText);
            expect(result).toBeDefined();
        });

        it('should handle unicode characters', async () => {
            const unicodeText = 'Test with emoji 😀 and symbols ∑∏∫';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"Unicode","refined_text":"- Unicode\\n"}]' } }],
            });

            const result = await clean(unicodeText);
            expect(result).toBeDefined();
        });

        it('should handle newlines and tabs in input', async () => {
            const formattedText = 'Line 1\nLine 2\tTabbed';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"Formatted","refined_text":"- Formatted\\n"}]' } }],
            });

            const result = await clean(formattedText);
            expect(result).toBeDefined();
        });
    });

    describe('Error Scenarios', () => {
        it('should handle network timeout errors', async () => {
            const rawText = 'Test';
            const timeoutError = new Error('ETIMEDOUT');
            timeoutError.code = 'ETIMEDOUT';

            mockGroqClient.chat.completions.create.mockRejectedValue(timeoutError);

            await expect(clean(rawText)).rejects.toThrow('ETIMEDOUT');
            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(3);
        });

        it('should handle 429 rate limit errors', async () => {
            const rawText = 'Test';
            const rateLimitError = new Error('Rate limit exceeded');
            rateLimitError.status = 429;

            mockGroqClient.chat.completions.create.mockRejectedValue(rateLimitError);

            await expect(clean(rawText)).rejects.toThrow();
            expect(mockGroqClient.chat.completions.create).toHaveBeenCalledTimes(3);
        });

        it('should handle 401 authentication errors', async () => {
            const rawText = 'Test';
            const authError = new Error('Unauthorized');
            authError.status = 401;

            mockGroqClient.chat.completions.create.mockRejectedValue(authError);

            await expect(clean(rawText)).rejects.toThrow('Unauthorized');
        });

        it('should handle unexpected response structure', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                unexpected: 'structure',
            });

            await expect(clean(rawText)).rejects.toThrow();
        });
    });

    describe('Logging Behavior', () => {
        let consoleSpy;

        beforeEach(() => {
            consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            jest.spyOn(console, 'warn').mockImplementation();
            jest.spyOn(console, 'error').mockImplementation();
        });

        afterEach(() => {
            consoleSpy.mockRestore();
            console.warn.mockRestore();
            console.error.mockRestore();
        });

        it('should log attempt number on each retry', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create
                .mockRejectedValueOnce(new Error('Fail'))
                .mockResolvedValueOnce({
                    choices: [{ message: { content: '[{"summary":"OK","refined_text":"- OK\\n"}]' } }],
                });

            await clean(rawText);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Attempt 1'));
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Attempt 2'));
        });

        it('should log successful parsing', async () => {
            const rawText = 'Test';
            mockGroqClient.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: '[{"summary":"OK","refined_text":"- OK\\n"}]' } }],
            });

            await clean(rawText);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Parsed'));
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('successfully'));
        });
    });
});