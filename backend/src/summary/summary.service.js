// Generates incremental meeting summaries using the prompt registry.

'use strict';

const { getSummaryInference } = require('../providers/llm/inference.provider');
const { runResilient } = require('../providers/llm/resilient.inference');
const { startSummaryUpdate, saveSummaryContent } = require('./summary.repository');
const { getPrompt } = require('../../prompts/registry');
const { createLogger } = require('../core/logger');

const logger = createLogger('summaryService');

/**
 * Generates an incremental update to the meeting summary.
 * @param {string} currentSummary - The existing summary text (or empty string).
 * @param {string} newTranscript - The new chunk of transcription.
 * @param {number} wordLimit - The target word count.
 * @param {{ hasSpeakers?: boolean }} [context] - Context for prompt selection.
 * @returns {Promise<Object>} The updated title and summary text.
 */
const generateIncrementalSummary = async (currentSummary, newTranscript, wordLimit, context = {}) => {
    // Resolve the correct prompt template via the registry
    const getSummaryPrompt = getPrompt('summary', context);

    if (typeof getSummaryPrompt !== 'function') {
        throw new Error('Summary prompt did not resolve to a template function');
    }

    const prompt = getSummaryPrompt(currentSummary, newTranscript, wordLimit);

    try {
        const { client, model, taskConfig } = getSummaryInference();
        logger.debug('Generating summary', { provider: taskConfig.provider, model });

        const completion = await runResilient(taskConfig.provider, () =>
            client.chat.completions.create({
                messages: [
                    { role: 'user', content: prompt }
                ],
                model: model,
                response_format: { type: 'json_object' },
            })
        );

        const result = completion.choices[0]?.message?.content;
        if (!result) {
            throw new Error('Empty response from LLM');
        }

        const parsed = JSON.parse(result);
        if (!parsed.summary || !parsed.title) {
            throw new Error('Invalid structure from LLM. Missing title or summary.');
        }

        return parsed;
    } catch (error) {
        logger.error('LLM_SUMMARY_ERROR', { error: error.message });
        throw error;
    }
};

/**
 * Orchestrates the full update process for a chunk.
 * @param {string} jobId
 * @param {string} rawText
 * @param {number} chunkIndex
 * @param {{ hasSpeakers?: boolean }} [context]
 */
const processSummaryUpdate = async (jobId, rawText, chunkIndex, context = {}) => {
    try {
        const summaryDoc = await startSummaryUpdate(jobId, chunkIndex);
        if (!summaryDoc) return;

        const updatedData = await generateIncrementalSummary(
            summaryDoc.content,
            rawText,
            summaryDoc.wordLimit,
            context,
        );

        await saveSummaryContent(jobId, updatedData, chunkIndex);
    } catch (error) {
        throw error;
    }
};

module.exports = { processSummaryUpdate };
