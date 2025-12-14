const config = require('../config');
const BaseKeyRotationService = require('./baseKeyRotation');

class GeminiService extends BaseKeyRotationService {
    constructor() {
        super(config.GEMINI_API_KEYS, 'Gemini');
    }

    /**
     * Returns a GoogleGenAI client with a rotated API key.
     * Matches the pattern used by GroqService for consistency.
     */
    getClient() {
        const { GoogleGenAI } = require('@google/genai');
        const key = this.getNextKey();
        return new GoogleGenAI({ apiKey: key });
    }
}

// Singleton instance
module.exports = new GeminiService();
