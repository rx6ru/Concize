// tests/embeddingService.test.js

const { getEmbedding } = require('../controllers/embedding/embeddingService');

// Mock dependencies
jest.mock('@google/genai');
jest.mock('../../utils/llm/geminiService');
jest.mock('../../utils/config', () => ({
    GEMINI_API_KEYS: ['test-key-1', 'test-key-2'],
}));

const { GoogleGenAI } = require('@google/genai');
const geminiService = require('../../utils/llm/geminiService');

describe('embeddingService - getEmbedding()', () => {
    let mockAIInstance;

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup default mock AI instance
        mockAIInstance = {
            models: {
                embedContent: jest.fn(),
            },
        };

        GoogleGenAI.mockReturnValue(mockAIInstance);
        geminiService.getNextKey = jest.fn().mockReturnValue('test-api-key');
    });

    describe('Happy Path - Standard Response Shapes', () => {
        it('should successfully generate embedding with embedding.values shape', async () => {
            const mockVector = new Array(768).fill(0.1);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
            expect(result.length).toBe(768);
        });

        it('should handle embeddings array with values', async () => {
            const mockVector = new Array(768).fill(0.2);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embeddings: [{ values: mockVector }],
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
        });

        it('should handle data array response shape', async () => {
            const mockVector = new Array(768).fill(0.3);
            mockAIInstance.models.embedContent.mockResolvedValue({
                data: [{ embedding: mockVector }],
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
        });

        it('should handle output.embeddings shape', async () => {
            const mockVector = new Array(768).fill(0.4);
            mockAIInstance.models.embedContent.mockResolvedValue({
                output: {
                    embeddings: [mockVector],
                },
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
        });

        it('should handle nested embeddings with values in output', async () => {
            const mockVector = new Array(768).fill(0.5);
            mockAIInstance.models.embedContent.mockResolvedValue({
                output: {
                    embeddings: [{ values: mockVector }],
                },
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
        });
    });

    describe('SDK Method Fallback Mechanism', () => {
        it('should try multiple SDK methods until one succeeds', async () => {
            const mockVector = new Array(768).fill(0.6);
            
            mockAIInstance.models.embedContent = undefined;
            mockAIInstance.models.embed = jest.fn().mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
        });

        it('should fall back to top-level embedContent method', async () => {
            const mockVector = new Array(768).fill(0.7);
            
            mockAIInstance.models = {};
            mockAIInstance.embedContent = jest.fn().mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test text');

            expect(result).toEqual(mockVector);
        });

        it('should throw error when no SDK method works', async () => {
            mockAIInstance.models = {};
            mockAIInstance.embedContent = undefined;

            await expect(getEmbedding('test text')).rejects.toThrow(
                'No embedding method found'
            );
        });

        it('should propagate last error if all methods fail', async () => {
            const testError = new Error('API Error');
            mockAIInstance.models.embedContent = jest.fn().mockRejectedValue(testError);
            mockAIInstance.models.embed = jest.fn().mockRejectedValue(testError);
            mockAIInstance.models.embed_content = jest.fn().mockRejectedValue(testError);

            await expect(getEmbedding('test text')).rejects.toThrow();
        });
    });

    describe('Key Rotation Integration', () => {
        it('should call geminiService.getNextKey() to rotate keys', async () => {
            const mockVector = new Array(768).fill(0.8);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding('test text');

            expect(geminiService.getNextKey).toHaveBeenCalledTimes(1);
        });

        it('should create GoogleGenAI instance with rotated key', async () => {
            geminiService.getNextKey.mockReturnValue('rotated-key-xyz');
            const mockVector = new Array(768).fill(0.9);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding('test text');

            expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'rotated-key-xyz' });
        });

        it('should use different keys on consecutive calls', async () => {
            geminiService.getNextKey
                .mockReturnValueOnce('key-1')
                .mockReturnValueOnce('key-2')
                .mockReturnValueOnce('key-3');

            const mockVector = new Array(768).fill(0.5);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding('text 1');
            await getEmbedding('text 2');
            await getEmbedding('text 3');

            expect(GoogleGenAI).toHaveBeenNthCalledWith(1, { apiKey: 'key-1' });
            expect(GoogleGenAI).toHaveBeenNthCalledWith(2, { apiKey: 'key-2' });
            expect(GoogleGenAI).toHaveBeenNthCalledWith(3, { apiKey: 'key-3' });
        });
    });

    describe('Request Configuration', () => {
        it('should use default model and dimensionality', async () => {
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding('test text');

            expect(mockAIInstance.models.embedContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'gemini-embedding-001',
                    contents: [{ parts: [{ text: 'test text' }] }],
                    config: { outputDimensionality: 768 },
                })
            );
        });

        it('should accept custom output dimensionality', async () => {
            const mockVector = new Array(256).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding('test text', { outputDimensionality: 256 });

            expect(mockAIInstance.models.embedContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    config: { outputDimensionality: 256 },
                })
            );
        });

        it('should accept custom model override', async () => {
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding('test text', { model: 'custom-embedding-model' });

            expect(mockAIInstance.models.embedContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'custom-embedding-model',
                })
            );
        });

        it('should format text input correctly', async () => {
            const testText = 'This is a test with multiple words.';
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await getEmbedding(testText);

            expect(mockAIInstance.models.embedContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    contents: [{ parts: [{ text: testText }] }],
                })
            );
        });
    });

    describe('Input Validation', () => {
        it('should throw TypeError for non-string input', async () => {
            await expect(getEmbedding(123)).rejects.toThrow(TypeError);
            await expect(getEmbedding(123)).rejects.toThrow('non-empty string');
        });

        it('should throw TypeError for null input', async () => {
            await expect(getEmbedding(null)).rejects.toThrow(TypeError);
        });

        it('should throw TypeError for undefined input', async () => {
            await expect(getEmbedding(undefined)).rejects.toThrow(TypeError);
        });

        it('should throw TypeError for empty string', async () => {
            await expect(getEmbedding('')).rejects.toThrow(TypeError);
        });

        it('should throw TypeError for whitespace-only string', async () => {
            await expect(getEmbedding('   ')).rejects.toThrow(TypeError);
            await expect(getEmbedding('\n\t  ')).rejects.toThrow(TypeError);
        });

        it('should throw TypeError for object input', async () => {
            await expect(getEmbedding({ text: 'hello' })).rejects.toThrow(TypeError);
        });

        it('should throw TypeError for array input', async () => {
            await expect(getEmbedding(['hello', 'world'])).rejects.toThrow(TypeError);
        });
    });

    describe('Edge Cases - Valid Inputs', () => {
        it('should handle single character input', async () => {
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('a');

            expect(result).toEqual(mockVector);
        });

        it('should handle very long text input', async () => {
            const longText = 'A'.repeat(10000);
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding(longText);

            expect(result).toBeDefined();
        });

        it('should handle special characters', async () => {
            const specialText = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`';
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding(specialText);

            expect(result).toEqual(mockVector);
        });

        it('should handle unicode and emoji', async () => {
            const unicodeText = 'Hello 世界 🌍 ∑∏∫';
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding(unicodeText);

            expect(result).toEqual(mockVector);
        });

        it('should handle newlines and formatting', async () => {
            const formattedText = 'Line 1\nLine 2\n\tTabbed line\rCarriage return';
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding(formattedText);

            expect(result).toEqual(mockVector);
        });
    });

    describe('Error Response Handling', () => {
        it('should throw error when response has no usable vector', async () => {
            mockAIInstance.models.embedContent.mockResolvedValue({
                someOtherField: 'unexpected',
            });

            await expect(getEmbedding('test')).rejects.toThrow(
                'Embedding response did not contain a usable vector'
            );
        });

        it('should throw error when vector is empty array', async () => {
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: [] },
            });

            await expect(getEmbedding('test')).rejects.toThrow(
                'Embedding response did not contain a usable vector'
            );
        });

        it('should throw error when vector is not an array', async () => {
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: 'not-an-array' },
            });

            await expect(getEmbedding('test')).rejects.toThrow();
        });

        it('should handle API errors gracefully', async () => {
            const apiError = new Error('API rate limit exceeded');
            mockAIInstance.models.embedContent.mockRejectedValue(apiError);

            await expect(getEmbedding('test')).rejects.toThrow('API rate limit exceeded');
        });

        it('should handle network timeouts', async () => {
            const timeoutError = new Error('ETIMEDOUT');
            timeoutError.code = 'ETIMEDOUT';
            mockAIInstance.models.embedContent.mockRejectedValue(timeoutError);

            await expect(getEmbedding('test')).rejects.toThrow('ETIMEDOUT');
        });

        it('should handle authentication errors', async () => {
            const authError = new Error('401 Unauthorized');
            mockAIInstance.models.embedContent.mockRejectedValue(authError);

            await expect(getEmbedding('test')).rejects.toThrow('401 Unauthorized');
        });
    });

    describe('Vector Quality', () => {
        it('should return vector of correct dimensionality', async () => {
            const mockVector = new Array(768).fill(0.1);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test');

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(768);
        });

        it('should return numeric values in vector', async () => {
            const mockVector = [0.1, 0.2, 0.3, 0.4, 0.5];
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test', { outputDimensionality: 5 });

            result.forEach(value => {
                expect(typeof value).toBe('number');
                expect(isNaN(value)).toBe(false);
            });
        });

        it('should handle vector with negative values', async () => {
            const mockVector = [-0.5, 0.3, -0.1, 0.8, -0.2];
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test', { outputDimensionality: 5 });

            expect(result).toEqual(mockVector);
        });

        it('should handle vector with zero values', async () => {
            const mockVector = new Array(768).fill(0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const result = await getEmbedding('test');

            expect(result.every(v => v === 0)).toBe(true);
        });
    });

    describe('Concurrent Requests', () => {
        it('should handle multiple concurrent embedding requests', async () => {
            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            const promises = [
                getEmbedding('text 1'),
                getEmbedding('text 2'),
                getEmbedding('text 3'),
            ];

            const results = await Promise.all(promises);

            expect(results.length).toBe(3);
            results.forEach(result => {
                expect(result).toEqual(mockVector);
            });
        });

        it('should rotate keys correctly across concurrent requests', async () => {
            geminiService.getNextKey
                .mockReturnValueOnce('key-1')
                .mockReturnValueOnce('key-2')
                .mockReturnValueOnce('key-3');

            const mockVector = new Array(768).fill(1.0);
            mockAIInstance.models.embedContent.mockResolvedValue({
                embedding: { values: mockVector },
            });

            await Promise.all([
                getEmbedding('text 1'),
                getEmbedding('text 2'),
                getEmbedding('text 3'),
            ]);

            expect(geminiService.getNextKey).toHaveBeenCalledTimes(3);
        });
    });
});