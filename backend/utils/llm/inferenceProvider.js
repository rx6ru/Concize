// utils/llm/inferenceProvider.js
// Per-task inference routing — returns the correct LLM client + model for each task
//
// Usage:
//   const { getChatInference } = require('../utils/llm/inferenceProvider');
//   const { client, model, taskConfig } = getChatInference();
//   const stream = await client.chat.completions.create({ model, ... });

const config = require('../../configs/appConfig');
const groqService = require('./groqService');
const cerebrasService = require('./cerebrasService');

/**
 * Returns the correct service singleton based on provider name.
 * @param {string} provider - 'groq' or 'cerebras'
 * @returns {Object} Service instance with getClient()
 */
function getService(provider) {
    switch (provider) {
        case 'groq':
            return groqService;
        case 'cerebras':
            return cerebrasService;
        default:
            throw new Error(`Unknown inference provider: "${provider}"`);
    }
}

/**
 * Returns { client, model, taskConfig } for the chat task.
 */
function getChatInference() {
    const taskConfig = config.inference.chat;
    const service = getService(taskConfig.provider);
    return {
        client: service.getClient(),
        model: taskConfig.model,
        taskConfig,
    };
}

/**
 * Returns { client, model, taskConfig } for the clean task.
 */
function getCleanInference() {
    const taskConfig = config.inference.clean;
    const service = getService(taskConfig.provider);
    return {
        client: service.getClient(),
        model: taskConfig.model,
        taskConfig,
    };
}

/**
 * Returns { client, model, taskConfig } for the summary task.
 */
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
