const BaseKeyRotationService = require('../src/providers/llm/key.rotation');

describe('BaseKeyRotationService', () => {
    test('should rotate keys in round-robin order', () => {
        const testKeys = ['key-A', 'key-B', 'key-C'];
        const service = new BaseKeyRotationService(testKeys, 'TestService');

        expect(service.getNextKey()).toBe('key-A');
        expect(service.getNextKey()).toBe('key-B');
        expect(service.getNextKey()).toBe('key-C');
        expect(service.getNextKey()).toBe('key-A'); // Cycle back
        expect(service.getNextKey()).toBe('key-B');
    });

    test('should handle single key correctly', () => {
        const testKeys = ['single-key'];
        const service = new BaseKeyRotationService(testKeys, 'TestService');

        expect(service.getNextKey()).toBe('single-key');
        expect(service.getNextKey()).toBe('single-key');
    });

    test('should throw error if no keys configured on getNextKey', () => {
        const service = new BaseKeyRotationService([], 'TestService');
        expect(() => service.getNextKey()).toThrow('No API keys configured for TestService');
    });
});
