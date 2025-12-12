// utils/keyRotation.js
const config = require('./config');

class KeyRotationService {
    constructor() {
        this.keys = config.GEMINI_API_KEYS || [];
        this.currentIndex = 0;

        if (this.keys.length === 0) {
            console.warn('WARNING: No Gemini API keys found in config.GEMINI_API_KEYS');
        } else {
            console.log(`KeyRotationService initialized with ${this.keys.length} keys.`);
        }
    }

    /**
     * Returns the next key in the round-robin sequence.
     * Updates the internal index.
     * @returns {string} The API key.
     * @throws {Error} If no keys are available.
     */
    getNextKey() {
        if (this.keys.length === 0) {
            throw new Error('No Gemini API keys configured.');
        }

        const key = this.keys[this.currentIndex];
        // Round-robin increment
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;

        // Log rotation only if we have multiple keys to avoid spam
        if (this.keys.length > 1) {
            console.log(`[KeyRotation] Switched to key index ${this.currentIndex} (next request will use this). Used key index: ${(this.currentIndex - 1 + this.keys.length) % this.keys.length}`);
        }

        return key;
    }

    /**
     * helper to add keys dynamically (mainly for testing)
     * @param {string[]} newKeys 
     */
    setKeys(newKeys) {
        this.keys = newKeys;
        this.currentIndex = 0;
    }
}

// Singleton instance
const keyRotation = new KeyRotationService();
module.exports = keyRotation;
