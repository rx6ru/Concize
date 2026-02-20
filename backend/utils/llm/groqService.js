const Groq = require('groq-sdk');
const config = require('../../configs/appConfig');
const BaseKeyRotationService = require('./baseKeyRotation');

class GroqService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.groqKeys, 'Groq');
    }

    /**
     * Returns a new Groq client instance with the next key in rotation.
     * @throws {Error} If no valid key is available or client instantiation fails.
     */
    getClient() {
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid Groq API key available');
        }
        try {
            return new Groq({ apiKey: key });
        } catch (error) {
            throw new Error(`Failed to create Groq client: ${error.message}`);
        }
    }
}

// Singleton instance
module.exports = new GroqService();
