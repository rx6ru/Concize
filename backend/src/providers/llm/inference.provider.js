// Per-task inference routing: returns the correct LLM client + model for each task

const config = require('../../core/config');
const groqService = require('./groq');
const cerebrasService = require('./cerebras');
const openrouterService = require('./openrouter');

/**
 * Returns the correct service singleton based on provider name.
 * @param {string} provider - 'groq', 'cerebras' or 'openrouter'
 * @returns {Object} Service instance with getClient()
 */
function getService(provider) {
    switch (provider) {
        case 'groq':
            return groqService;
        case 'cerebras':
            return cerebrasService;
        case 'openrouter':
            return openrouterService;
        default:
            throw new Error(`Unknown inference provider: "${provider}"`);
    }
}

function getChatInference() {
    const taskConfig = config.inference.chat;
    const service = getService(taskConfig.provider);
    return {
        client: service.getClient(),
        model: taskConfig.model,
        taskConfig,
    };
}

function getCleanInference() {
    const taskConfig = config.inference.clean;
    const service = getService(taskConfig.provider);
    return {
        client: service.getClient(),
        model: taskConfig.model,
        taskConfig,
    };
}

function getSummaryInference() {
    const taskConfig = config.inference.summary;
    const service = getService(taskConfig.provider);
    return {
        client: service.getClient(),
        model: taskConfig.model,
        taskConfig,
    };
}

module.exports = {
    getChatInference,
    getCleanInference,
    getSummaryInference,
    getService,
};
