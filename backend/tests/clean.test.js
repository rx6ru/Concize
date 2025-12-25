// tests/clean.test.js

// Mock config
jest.mock('../utils/config', () => ({
    GROQ_CHAT_MODEL: 'mock-model',
}));

// Mock Groq service
jest.mock('../utils/llm/groqService', () => ({
    getClient: jest.fn(),
}));

// Mock secure prompt module
jest.mock('../.secrets/transcriptClean', () => ({
    TRANSCRIPT_CLEAN_PROMPT: 'Mock System Prompt',
}));

const groqService = require('../utils/llm/groqService');
const { clean } = require('../controllers/clean.js');

describe('clean.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should use the secure prompt and return parsed JSON', async () => {
        const mockGroqClient = {
            chat: {
                completions: {
                    create: jest.fn(),
                },
            },
        };
        groqService.getClient.mockReturnValue(mockGroqClient);

        const mockResponse = [
            { summary: 'Test summary', refined_text: '- Test line' }
        ];

        mockGroqClient.chat.completions.create.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify(mockResponse),
                },
            }],
        });

        const result = await clean('Raw text');

        expect(result).toEqual(mockResponse);
        expect(mockGroqClient.chat.completions.create).toHaveBeenCalledWith(expect.objectContaining({
            messages: expect.arrayContaining([
                { role: 'system', content: 'Mock System Prompt' },
                { role: 'user', content: 'Raw text' }
            ])
        }));
    });
});
