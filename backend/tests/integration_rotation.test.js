const { getEmbedding } = require('../services/embedding/embeddingService');
const geminiService = require('../utils/llm/geminiService');

// Mock geminiService
jest.mock('../utils/llm/geminiService', () => ({
    getClient: jest.fn().mockReturnValue({
        models: {
            embedContent: jest.fn().mockResolvedValue({
                embedding: { values: new Array(768).fill(0.1) }
            })
        }
    })
}));

describe('Key Rotation Integration (Gemini)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getEmbedding should call geminiService.getClient()', async () => {
        await getEmbedding("test text");

        expect(geminiService.getClient).toHaveBeenCalled();
    });
});
