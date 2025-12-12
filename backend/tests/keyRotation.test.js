// tests/keyRotation.test.js
const keyRotation = require('../utils/keyRotation');

describe('KeyRotationService', () => {
    // Save original keys to restore after test
    const originalKeys = [...keyRotation.keys];

    afterEach(() => {
        keyRotation.setKeys(originalKeys);
    });

    test('should rotate keys in round-robin order', () => {
        const testKeys = ['key-A', 'key-B', 'key-C'];
        keyRotation.setKeys(testKeys);

        expect(keyRotation.getNextKey()).toBe('key-A');
        expect(keyRotation.getNextKey()).toBe('key-B');
        expect(keyRotation.getNextKey()).toBe('key-C');
        expect(keyRotation.getNextKey()).toBe('key-A'); // Cycle back
        expect(keyRotation.getNextKey()).toBe('key-B');
    });

    test('should handle single key correctly', () => {
        const testKeys = ['single-key'];
        keyRotation.setKeys(testKeys);

        expect(keyRotation.getNextKey()).toBe('single-key');
        expect(keyRotation.getNextKey()).toBe('single-key');
    });

    test('should throw error if no keys configured', () => {
        keyRotation.setKeys([]);
        expect(() => keyRotation.getNextKey()).toThrow('No Gemini API keys configured');
    });
});
