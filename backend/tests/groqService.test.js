// tests/groqService.test.js

const Groq = require('groq-sdk');

// Mock Groq SDK
jest.mock('groq-sdk');

// Mock config before requiring groqService
jest.mock('../utils/config', () => ({
    GROQ_API_KEYS: ['groq-key-1', 'groq-key-2', 'groq-key-3'],
}));

// Mock BaseKeyRotationService
jest.mock('../utils/llm/baseKeyRotation');

describe('GroqService', () => {
    let groqService;
    let BaseKeyRotationService;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Clear module cache to get fresh instance
        jest.resetModules();
        
        // Re-require after clearing cache
        BaseKeyRotationService = require('../utils/llm/baseKeyRotation');
        groqService = require('../utils/llm/groqService');
    });

    describe('Initialization', () => {
        it('should be a singleton instance', () => {
            const instance1 = require('../utils/llm/groqService');
            const instance2 = require('../utils/llm/groqService');
            
            expect(instance1).toBe(instance2);
        });

        it('should extend BaseKeyRotationService', () => {
            expect(BaseKeyRotationService).toHaveBeenCalled();
        });

        it('should initialize with GROQ_API_KEYS from config', () => {
            expect(BaseKeyRotationService).toHaveBeenCalledWith(
                ['groq-key-1', 'groq-key-2', 'groq-key-3'],
                'Groq'
            );
        });
    });

    describe('getClient()', () => {
        beforeEach(() => {
            // Mock the getNextKey method on the instance
            groqService.getNextKey = jest.fn();
        });

        it('should call getNextKey to retrieve an API key', () => {
            groqService.getNextKey.mockReturnValue('groq-key-1');

            groqService.getClient();

            expect(groqService.getNextKey).toHaveBeenCalledTimes(1);
        });

        it('should return a new Groq client instance', () => {
            groqService.getNextKey.mockReturnValue('groq-key-1');
            const mockGroqInstance = { chat: {} };
            Groq.mockReturnValue(mockGroqInstance);

            const client = groqService.getClient();

            expect(Groq).toHaveBeenCalledWith({ apiKey: 'groq-key-1' });
            expect(client).toBe(mockGroqInstance);
        });

        it('should create new client with rotated key on subsequent calls', () => {
            groqService.getNextKey
                .mockReturnValueOnce('groq-key-1')
                .mockReturnValueOnce('groq-key-2')
                .mockReturnValueOnce('groq-key-3');

            groqService.getClient();
            groqService.getClient();
            groqService.getClient();

            expect(Groq).toHaveBeenNthCalledWith(1, { apiKey: 'groq-key-1' });
            expect(Groq).toHaveBeenNthCalledWith(2, { apiKey: 'groq-key-2' });
            expect(Groq).toHaveBeenNthCalledWith(3, { apiKey: 'groq-key-3' });
        });

        it('should create independent client instances', () => {
            groqService.getNextKey.mockReturnValue('groq-key-1');
            const mockInstance1 = { id: 1 };
            const mockInstance2 = { id: 2 };
            Groq.mockReturnValueOnce(mockInstance1).mockReturnValueOnce(mockInstance2);

            const client1 = groqService.getClient();
            const client2 = groqService.getClient();

            expect(client1).not.toBe(client2);
            expect(client1).toBe(mockInstance1);
            expect(client2).toBe(mockInstance2);
        });
    });

    describe('Error Handling', () => {
        it('should propagate error if getNextKey throws', () => {
            groqService.getNextKey = jest.fn().mockImplementation(() => {
                throw new Error('No API keys configured for Groq');
            });

            expect(() => groqService.getClient()).toThrow('No API keys configured for Groq');
        });

        it('should propagate error if Groq constructor throws', () => {
            groqService.getNextKey.mockReturnValue('invalid-key');
            Groq.mockImplementation(() => {
                throw new Error('Invalid API key format');
            });

            expect(() => groqService.getClient()).toThrow('Invalid API key format');
        });
    });

    describe('Integration with Key Rotation', () => {
        it('should maintain rotation state across multiple getClient calls', () => {
            let keyIndex = 0;
            const keys = ['key-A', 'key-B', 'key-C'];
            
            groqService.getNextKey = jest.fn().mockImplementation(() => {
                const key = keys[keyIndex % keys.length];
                keyIndex++;
                return key;
            });

            groqService.getClient();
            groqService.getClient();
            groqService.getClient();
            groqService.getClient();

            expect(Groq).toHaveBeenNthCalledWith(1, { apiKey: 'key-A' });
            expect(Groq).toHaveBeenNthCalledWith(2, { apiKey: 'key-B' });
            expect(Groq).toHaveBeenNthCalledWith(3, { apiKey: 'key-C' });
            expect(Groq).toHaveBeenNthCalledWith(4, { apiKey: 'key-A' });
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty string API key', () => {
            groqService.getNextKey.mockReturnValue('');
            
            groqService.getClient();

            expect(Groq).toHaveBeenCalledWith({ apiKey: '' });
        });

        it('should handle null API key from getNextKey', () => {
            groqService.getNextKey.mockReturnValue(null);
            
            groqService.getClient();

            expect(Groq).toHaveBeenCalledWith({ apiKey: null });
        });

        it('should handle undefined API key from getNextKey', () => {
            groqService.getNextKey.mockReturnValue(undefined);
            
            groqService.getClient();

            expect(Groq).toHaveBeenCalledWith({ apiKey: undefined });
        });
    });
});