const config = require('../../configs');
const BaseKeyRotationService = require('./baseKeyRotation');

class GeminiService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.geminiKeys, 'Gemini');
    }

    /**
     * Returns a GoogleGenAI client with a rotated API key.
     * @throws {Error} If no valid key is available or client instantiation fails.
     */
    getClient() {
        const { GoogleGenAI } = require('@google/genai');
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid Gemini API key available');
        }
        try {
            return new GoogleGenAI({ apiKey: key });
        } catch (error) {
            throw new Error(`Failed to create Gemini client: ${error.message}`);
        }
    }
}

// Singleton instance
module.exports = new GeminiService();
