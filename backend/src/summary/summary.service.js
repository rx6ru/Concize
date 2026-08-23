// Generates incremental meeting summaries using the prompt registry.

'use strict';

const { getSummaryInference } = require('../providers/llm/inference.provider');
const { runResilient } = require('../providers/llm/resilient.inference');
const { startSummaryUpdate, saveSummaryContent } = require('./summary.repository');
const { getPrompt } = require('../../prompts/registry');
const { createLogger } = require('../core/logger');

const logger = createLogger('summaryService');


// A model asked for JSON still emits a raw newline or tab inside a string value now and then, and
// JSON.parse rejects the whole document for it. Observed in production as
// "Bad control character in string literal in JSON at position 1028", which cost the summary for
// that chunk. Escaping them is a repair, not a reinterpretation: the text is unchanged.
function parseLenient(text) {
    try {
        return JSON.parse(text);
    } catch (first) {
        let repaired = '';
        let inString = false;
        let escaped = false;
        for (const ch of text) {
            if (escaped) { repaired += ch; escaped = false; continue; }
            if (ch === '\\' && inString) { repaired += ch; escaped = true; continue; }
            if (ch === '"') { inString = !inString; repaired += ch; continue; }
            if (inString && ch < ' ') {
                repaired += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t'
                    : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
                continue;
            }
            repaired += ch;
        }
        // Throw the original error if the repair did not help; it names the position, which is the
        // useful half of the message.
        try { return JSON.parse(repaired); } catch { throw first; }
    }
}

/**
 * Generates an incremental update to the meeting summary.
 * @param {string} currentSummary existing summary text, or empty string
 * @param {string} newTranscript
 * @param {number} wordLimit
 * @param {{ hasSpeakers?: boolean }} [context] for prompt selection
 * @returns {Promise<Object>} updated title and summary text
 */
const generateIncrementalSummary = async (currentSummary, newTranscript, wordLimit, context = {}) => {
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

        const parsed = parseLenient(result);
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

module.exports = { processSummaryUpdate, parseLenient };
