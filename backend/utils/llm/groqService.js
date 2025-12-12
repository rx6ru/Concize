const Groq = require('groq-sdk');
const config = require('../config');
const BaseKeyRotationService = require('./baseKeyRotation');

class GroqService extends BaseKeyRotationService {
    constructor() {
        super(config.GROQ_API_KEYS, 'Groq');
    }

    /**
     * returns a new Groq client instance with the next key in rotation
     */
    getClient() {
        const key = this.getNextKey();
        return new Groq({ apiKey: key });
    }
}

// Singleton instance
module.exports = new GroqService();
