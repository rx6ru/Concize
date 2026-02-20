const fs = require('fs');
const path = require('path');
const { getSummaryInference } = require('../utils/llm/inferenceProvider');
const { startSummaryUpdate, saveSummaryContent } = require('../db/mongoutils/summary.db');

// Load prompt template from secure module
const { getSummaryPrompt } = require('../.secrets/meetingSummary');

/**
 * Generates an incremental update to the meeting summary.
 * @param {string} currentSummary - The existing summary text (or empty string).
 * @param {string} newTranscript - The new chunk of transcription.
 * @param {number} wordLimit - The target word count.
 * @returns {Promise<Object>} The updated title and summary text.
 */
const generateIncrementalSummary = async (currentSummary, newTranscript, wordLimit) => {
    // 1. Construct prompt
    const prompt = getSummaryPrompt(currentSummary, newTranscript, wordLimit);


    // 2. Call LLM
    try {
        // Get inference client routed by config
        const { client, model, taskConfig } = getSummaryInference();
        console.log(`[Inference] Summary using ${taskConfig.provider} → ${model}`);

        const completion = await client.chat.completions.create({
            messages: [
                { role: 'user', content: prompt }
            ],
            model: model,
            response_format: { type: 'json_object' } // Enforce JSON
        });

        const result = completion.choices[0]?.message?.content;

        if (!result) {
            throw new Error("Empty response from LLM");
        }

        // 3. Parse JSON
        const parsed = JSON.parse(result);

        if (!parsed.summary || !parsed.title) {
            throw new Error("Invalid structure from LLM. Missing title or summary.");
        }

        return parsed;

    } catch (error) {
        console.error("LLM_SUMMARY_ERROR:", error);
        throw error;
    }
};

/**
 * Orchestrates the full update process for a chunk.
 * @param {string} jobId 
 * @param {string} rawText 
 * @param {number} chunkIndex 
 */
const processSummaryUpdate = async (jobId, rawText, chunkIndex) => {
    try {
        // 1. Lock/Start update (Ordering check)
        const summaryDoc = await startSummaryUpdate(jobId, chunkIndex);

        if (!summaryDoc) {
            // This might happen if 'startSummaryUpdate' throws or returns null logic changes.
            // With current db logic, it throws if out of order.
            return;
        }

        // 2. Generate
        const updatedData = await generateIncrementalSummary(
            summaryDoc.content,
            rawText,
            summaryDoc.wordLimit
        );

        // 3. Save
        await saveSummaryContent(jobId, updatedData, chunkIndex);

    } catch (error) {
        // Re-throw to let the worker handle retry/dead-letter
        throw error;
    }
};

module.exports = {
    processSummaryUpdate
};
