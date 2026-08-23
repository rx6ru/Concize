// OpenRouter inference client using Groq SDK with base URL override

const Groq = require('groq-sdk');
const config = require('../../core/config');
const BaseKeyRotationService = require('./key.rotation');

class OpenRouterService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.openrouterKeys, 'OpenRouter');
    }

    /**
     * Returns a Groq-compatible client instance pointed at the OpenRouter API.
     * @throws {Error} If no valid key is available or client instantiation fails.
     */
    getClient() {
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid OpenRouter API key available');
        }
        try {
            return new Groq({
                apiKey: key,
                baseURL: 'https://openrouter.ai/api/v1',
            });
        } catch (error) {
            throw new Error(`Failed to create OpenRouter client: ${error.message}`);
        }
    }
}

module.exports = new OpenRouterService();
