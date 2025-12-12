// tests/integration_rotation.test.js
const { getEmbedding } = require('../controllers/embedding/embeddingService');
const keyRotation = require('../utils/keyRotation');

// Mock keyRotation
jest.mock('../utils/keyRotation');
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

describe('Key Rotation Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getEmbedding should call keyRotation.getNextKey()', async () => {
        keyRotation.getNextKey.mockReturnValue('mock-key-1');

        await getEmbedding("test text");

        expect(keyRotation.getNextKey).toHaveBeenCalled();
    });
});
