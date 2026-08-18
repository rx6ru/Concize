const Groq = require('groq-sdk');
const config = require('../../core/config');
const BaseKeyRotationService = require('./key.rotation');

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

module.exports = new GroqService();
