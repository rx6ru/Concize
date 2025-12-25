// clean.js
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const groqService = require('../utils/llm/groqService');

// Load system prompt from secure module
const { TRANSCRIPT_CLEAN_PROMPT } = require('../.secrets/transcriptClean');
const SYSTEM_PROMPT = TRANSCRIPT_CLEAN_PROMPT;


/**
 * Processes a raw text transcript, refining it and converting it into a
 * structured JSON array of dialogue chunks. It includes a retry mechanism for
 * robustness.
 * @param {string} text The raw, unrefined transcript text.
 * @returns {Promise<Array>} A promise that resolves to a parsed JSON array
 * containing the structured and refined dialogue.
 */
const clean = async (text) => {
    const MAX_RETRIES = 3; // Define the maximum number of retry attempts
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`CLEANING_LOG: Attempt ${attempt} of ${MAX_RETRIES} to clean transcription.`);

            // Get rotated Groq client
            const groq = groqService.getClient();
            const chatCompletion = await groq.chat.completions.create({
                "messages": [
                    {
                        "role": "system",
                        "content": SYSTEM_PROMPT
                    },
                    {
                        "role": "user",
                        "content": text
                    }
                ],
                // Model from centralized config
                "model": config.GROQ_CHAT_MODEL,
                "temperature": 1,
                "max_completion_tokens": 8192,
                "top_p": 1,
                "stream": false,
                "reasoning_effort": "medium",
                "stop": null
            });

            const fullResponse = chatCompletion.choices[0]?.message?.content || '';

            let parsedJson;
            try {
                // Try to parse the entire response as JSON first
                parsedJson = JSON.parse(fullResponse);
            } catch {
                // Fall back to regex extraction if full parse fails
                const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
                if (!jsonMatch) {
                    console.warn(`CLEANING_LOG: No valid JSON array found on attempt ${attempt}. Retrying...`);
                    continue;
                }
                parsedJson = JSON.parse(jsonMatch[0]);
            }

            // Validate that parsedJson is an array
            if (!Array.isArray(parsedJson)) {
                console.warn(`CLEANING_LOG: Response is not a JSON array on attempt ${attempt}. Retrying...`);
                continue;
            }

            console.log(`CLEANING_LOG: Parsed ${parsedJson.length} structured chunks successfully on attempt ${attempt}.`);
            return parsedJson;

        } catch (e) {
            console.error(`CLEANING_LOG: Error during transcription cleaning on attempt ${attempt}:`, e.message);
            // If it's a parsing error or a Groq API error, we retry.
            if (attempt === MAX_RETRIES) {
                console.error('CLEANING_LOG: Max retries reached. Failing.');
                throw e; // Rethrow the original error after all retries are exhausted
            }
        }
    }

    // This part should not be reached unless all retries fail,
    // but it's a good practice to handle a final failure state.
    throw new Error('Failed to clean transcription after multiple attempts.');
};

module.exports = { clean };