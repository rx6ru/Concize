// Sarvam API client with key rotation — follows the same pattern as groqService, cerebrasService.
// Unlike OpenAI-compatible providers, Sarvam uses raw HTTP with api-subscription-key header.

'use strict';

const config = require('../../core/config');
const BaseKeyRotationService = require('./key.rotation');

class SarvamService extends BaseKeyRotationService {
    constructor() {
        super(config.inference.sarvamKeys, 'Sarvam');
    }

    /**
     * Returns the auth headers for the next API key in rotation.
     * Sarvam doesn't use an SDK — this returns headers for axios calls.
     * @returns {{ 'api-subscription-key': string }}
     */
    getHeaders() {
        const key = this.getNextKey();
        if (!key) {
            throw new Error('No valid Sarvam API key available');
        }
        return { 'api-subscription-key': key };
    }
}

// Singleton instance
module.exports = new SarvamService();
