const { getEmbedding } = require('../controllers/embedding/embeddingService');
const geminiService = require('../utils/llm/geminiService');

// Mock geminiService
jest.mock('../utils/llm/geminiService');
jest.mock('@google/genai', () => {
    return {
        GoogleGenAI: jest.fn().mockImplementation(({ apiKey }) => {
            return {
                models: {
                    embedContent: jest.fn().mockResolvedValue({
                        embedding: { values: new Array(768).fill(0.1) }
                    })
                }
            };
        })
    };
});

describe('Key Rotation Integration (Gemini)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getEmbedding should call geminiService.getNextKey()', async () => {
        geminiService.getNextKey.mockReturnValue('mock-key-1');

        await getEmbedding("test text");

        expect(geminiService.getNextKey).toHaveBeenCalled();
    });
});

