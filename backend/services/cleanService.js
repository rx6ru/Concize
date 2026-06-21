// services/cleanService.js
// Processes raw transcript text into structured narrative chunks.
// Uses the prompt registry to select the right prompt based on context.

'use strict';

const { getCleanInference } = require('../utils/llm/inferenceProvider');
const { runResilient } = require('../utils/llm/resilientInference');
const { getPrompt } = require('../.secrets/promptRegistry');
const { createLogger } = require('../utils/logger');

const logger = createLogger('cleanService');

/**
 * Processes a raw text transcript, converting it into a structured JSON array
 * of narrative chunks with summaries. Includes retry mechanism.
 *
 * @param {string} text - The raw transcript text (may include speaker labels)
 * @param {{ hasSpeakers?: boolean, provider?: string }} context - Context for prompt selection
 * @returns {Promise<Array<{ summary: string, narrative: string, mentionedNames: string[] }>>}
 */
const clean = async (text, context = {}) => {
    const MAX_RETRIES = 3;
    const systemPrompt = getPrompt('clean', context);

    if (!systemPrompt) {
        throw new Error('No clean prompt available — prompt registry returned null');
    }

    logger.info('Using clean prompt variant', {
        hasSpeakers: context.hasSpeakers || false,
        provider: context.provider || 'unknown',
    });

    // The outer loop retries ONLY malformed-JSON responses. Network/429/5xx resilience lives in
    // runResilient (limiter + jittered retry + breaker) — kept separate so the two retry layers
    // don't stack and amplify load.
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        logger.info('Attempting to clean transcription', { attempt, maxRetries: MAX_RETRIES });

        // Get inference client routed by config
        const { client, model, taskConfig } = getCleanInference();
        logger.debug('Cleaning using model', { provider: taskConfig.provider, model });

        // Transport errors (429/5xx exhausted) propagate out — do NOT loop on them here.
        const chatCompletion = await runResilient(taskConfig.provider, () =>
            client.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text },
                ],
                model,
                temperature: taskConfig.temperature,
                max_completion_tokens: taskConfig.maxTokens,
                top_p: 1,
                stream: false,
                stop: null,
            })
        );

        const fullResponse = chatCompletion.choices[0]?.message?.content || '';

        let parsedJson;
        try {
            parsedJson = JSON.parse(fullResponse);
        } catch {
            // Fall back to regex extraction if full parse fails
            const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                logger.warn('No valid JSON array found in response', { attempt });
                continue;
            }
            try {
                parsedJson = JSON.parse(jsonMatch[0]);
            } catch {
                logger.warn('Extracted JSON still invalid', { attempt });
                continue;
            }
        }

        if (!Array.isArray(parsedJson)) {
            logger.warn('Response is not a JSON array', { attempt });
            continue;
        }

        // Normalize: ensure every chunk has the expected shape
        const normalized = parsedJson.map((chunk) => ({
            summary: chunk.summary || '',
            narrative: chunk.narrative || chunk.refined_text || '', // backward compat
            mentionedNames: Array.isArray(chunk.mentionedNames) ? chunk.mentionedNames : [],
        }));

        logger.info('Transcription cleaned successfully', {
            chunks: normalized.length,
            attempt,
            hasNames: normalized.some(c => c.mentionedNames.length > 0),
        });

        return normalized;
    }

    throw new Error('Failed to clean transcription after multiple attempts.');
};

module.exports = { clean };