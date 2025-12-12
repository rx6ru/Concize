const config = require('../config');
const BaseKeyRotationService = require('./baseKeyRotation');

class GeminiService extends BaseKeyRotationService {
    constructor() {
        super(config.GEMINI_API_KEYS, 'Gemini');
    }

    // Inherits getNextKey(), enough for GoogleGenAI SDK usage
}

// Singleton instance
module.exports = new GeminiService();
