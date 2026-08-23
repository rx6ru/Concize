// Cerebras inference client using Groq SDK with base URL override

const Groq = require('groq-sdk');
const config = require('../../core/config');
const BaseKeyRotationService = require('./key.rotation');

class CerebrasService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.cerebrasKeys, 'Cerebras');
    }

    /**
     * Returns a Groq-compatible client instance pointed at the Cerebras API.
     * @throws {Error} If no valid key is available or client instantiation fails.
     */
    getClient() {
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid Cerebras API key available');
        }
        try {
            return this.wrapClient(new Groq({
                apiKey: key,
                baseURL: 'https://api.cerebras.ai/v1',
            }), key);
        } catch (error) {
            throw new Error(`Failed to create Cerebras client: ${error.message}`);
        }
    }
}

module.exports = new CerebrasService();
