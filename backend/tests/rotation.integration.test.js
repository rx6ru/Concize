const { getEmbedding } = require('../src/providers/embedding/embedding.service');
const geminiService = require('../src/providers/llm/gemini');

// Mock geminiService
jest.mock('../src/providers/llm/gemini', () => ({
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
