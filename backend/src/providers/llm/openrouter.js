// OpenRouter inference client.
//
// Not the Groq SDK the other providers reuse: it posts to a hardcoded /openai/v1/chat/completions,
// which is Groq's own path and 404s on OpenRouter's /api/v1. The OpenAI SDK is the compatible one.

const OpenAI = require('openai');
const config = require('../../core/config');
const BaseKeyRotationService = require('./key.rotation');

class OpenRouterService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.openrouterKeys, 'OpenRouter');
    }

    /**
     * Returns an OpenAI-compatible client instance pointed at the OpenRouter API.
     * @throws {Error} If no valid key is available or client instantiation fails.
     */
    getClient() {
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid OpenRouter API key available');
        }
        try {
            return new OpenAI({
                apiKey: key,
                baseURL: 'https://openrouter.ai/api/v1',
            });
        } catch (error) {
            throw new Error(`Failed to create OpenRouter client: ${error.message}`);
        }
    }
}

module.exports = new OpenRouterService();
