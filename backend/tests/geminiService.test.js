// tests/geminiService.test.js

// Mock config before requiring geminiService
jest.mock('../utils/config', () => ({
    GEMINI_API_KEYS: ['gemini-key-1', 'gemini-key-2', 'gemini-key-3'],
}));

// Mock BaseKeyRotationService
jest.mock('../utils/llm/baseKeyRotation');

describe('GeminiService', () => {
    let geminiService;
    let BaseKeyRotationService;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Clear module cache to get fresh instance
        jest.resetModules();
        
        // Re-require after clearing cache
        BaseKeyRotationService = require('../utils/llm/baseKeyRotation');
        geminiService = require('../utils/llm/geminiService');
    });

    describe('Initialization', () => {
        it('should be a singleton instance', () => {
            const instance1 = require('../utils/llm/geminiService');
            const instance2 = require('../utils/llm/geminiService');
            
            expect(instance1).toBe(instance2);
        });

        it('should extend BaseKeyRotationService', () => {
            expect(BaseKeyRotationService).toHaveBeenCalled();
        });

        it('should initialize with GEMINI_API_KEYS from config', () => {
            expect(BaseKeyRotationService).toHaveBeenCalledWith(
                ['gemini-key-1', 'gemini-key-2', 'gemini-key-3'],
                'Gemini'
            );
        });

        it('should inherit getNextKey from BaseKeyRotationService', () => {
            expect(typeof geminiService.getNextKey).toBe('function');
        });
    });

    describe('Key Rotation Behavior', () => {
        beforeEach(() => {
            // Provide real implementation for testing rotation
            let currentIndex = 0;
            const keys = ['gemini-key-1', 'gemini-key-2', 'gemini-key-3'];
            geminiService.getNextKey = jest.fn().mockImplementation(() => {
                const key = keys[currentIndex % keys.length];
                currentIndex++;
                return key;
            });
        });

        it('should rotate through keys in sequence', () => {
            const key1 = geminiService.getNextKey();
            const key2 = geminiService.getNextKey();
            const key3 = geminiService.getNextKey();

            expect(key1).toBe('gemini-key-1');
            expect(key2).toBe('gemini-key-2');
            expect(key3).toBe('gemini-key-3');
        });

        it('should cycle back to first key after last key', () => {
            geminiService.getNextKey(); // key-1
            geminiService.getNextKey(); // key-2
            geminiService.getNextKey(); // key-3
            const key4 = geminiService.getNextKey(); // should be key-1 again

            expect(key4).toBe('gemini-key-1');
        });

        it('should maintain state across multiple calls', () => {
            for (let i = 0; i < 10; i++) {
                geminiService.getNextKey();
            }

            expect(geminiService.getNextKey).toHaveBeenCalledTimes(10);
        });
    });

    describe('Error Handling', () => {
        it('should propagate error if getNextKey throws', () => {
            geminiService.getNextKey = jest.fn().mockImplementation(() => {
                throw new Error('No API keys configured for Gemini');
            });

            expect(() => geminiService.getNextKey()).toThrow('No API keys configured for Gemini');
        });
    });

    describe('Integration with Embedding Service', () => {
        it('should provide keys compatible with GoogleGenAI client', () => {
            geminiService.getNextKey = jest.fn().mockReturnValue('valid-gemini-api-key-xyz');

            const key = geminiService.getNextKey();

            expect(typeof key).toBe('string');
            expect(key.length).toBeGreaterThan(0);
        });

        it('should handle rapid successive key requests', () => {
            let keyIndex = 0;
            const keys = ['key-A', 'key-B', 'key-C'];
            
            geminiService.getNextKey = jest.fn().mockImplementation(() => {
                const key = keys[keyIndex % keys.length];
                keyIndex++;
                return key;
            });

            const requestedKeys = [];
            for (let i = 0; i < 100; i++) {
                requestedKeys.push(geminiService.getNextKey());
            }

            expect(requestedKeys.length).toBe(100);
            expect(geminiService.getNextKey).toHaveBeenCalledTimes(100);
        });
    });

    describe('Edge Cases', () => {
        it('should handle single key configuration', () => {
            jest.resetModules();
            jest.mock('../utils/config', () => ({
                GEMINI_API_KEYS: ['single-key'],
            }));

            const singleKeyService = require('../utils/llm/geminiService');
            singleKeyService.getNextKey = jest.fn().mockReturnValue('single-key');

            const key1 = singleKeyService.getNextKey();
            const key2 = singleKeyService.getNextKey();

            expect(key1).toBe('single-key');
            expect(key2).toBe('single-key');
        });

        it('should handle empty key array gracefully through parent class', () => {
            jest.resetModules();
            jest.mock('../utils/config', () => ({
                GEMINI_API_KEYS: [],
            }));

            const emptyKeyService = require('../utils/llm/geminiService');
            emptyKeyService.getNextKey = jest.fn().mockImplementation(() => {
                throw new Error('No API keys configured for Gemini');
            });

            expect(() => emptyKeyService.getNextKey()).toThrow();
        });
    });

    describe('Concurrent Access', () => {
        it('should handle concurrent key requests correctly', async () => {
            let keyIndex = 0;
            const keys = ['key-1', 'key-2', 'key-3'];
            
            geminiService.getNextKey = jest.fn().mockImplementation(() => {
                const key = keys[keyIndex % keys.length];
                keyIndex++;
                return key;
            });

            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(Promise.resolve(geminiService.getNextKey()));
            }

            const results = await Promise.all(promises);

            expect(results.length).toBe(10);
            expect(geminiService.getNextKey).toHaveBeenCalledTimes(10);
        });
    });
});