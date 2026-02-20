// utils/llm/cerebrasService.js
// Cerebras inference client using Groq SDK with base URL override
// https://inference-docs.cerebras.ai/resources/openai

const Groq = require('groq-sdk');
const config = require('../../configs');
const BaseKeyRotationService = require('./baseKeyRotation');

class CerebrasService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.cerebrasKeys, 'Cerebras');
    }

    /**
     * Returns a Groq-compatible client instance pointed at the Cerebras API.
     * Uses Groq SDK with baseURL override for OpenAI compatibility.
     * @throws {Error} If no valid key is available or client instantiation fails.
     */
    getClient() {
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid Cerebras API key available');
        }
        try {
            return new Groq({
                apiKey: key,
                baseURL: 'https://api.cerebras.ai/v1',
            });
        } catch (error) {
            throw new Error(`Failed to create Cerebras client: ${error.message}`);
        }
    }
}

// Singleton instance
module.exports = new CerebrasService();
