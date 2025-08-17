// clean.js
const Groq = require('groq-sdk');
const config = require('../utils/config');

// Initialize Groq SDK with API key from a config file
const groq = new Groq({
    apiKey: config.GROQ_API_KEY,
});

const sysPrompt = `You are a text processor for a video conference transcription. Your task is to refine, chunk, and summarize the provided unrefined transcript. The output MUST be a JSON array of objects. Each object in the array represents a single, semantically coherent chunk of the dialogue.
    
    Here are the specific rules you must follow:
    1. **Refine the Dialogue:** Correct grammar, remove filler words (e.g., 'you know,' 'like,' 'um,' 'ah'), and strip out any unnecessary or non-dialogue text.
    2. **Chunk the Dialogue:** Break the refined dialogue into small, logical chunks, typically based on a change in topic or a pause in the conversation.
    3. **Limits:** Each "refined_text" key cannot exceed 140 words. Break longer transcripts into as many chunks as needed to maintain this limit, typically resulting in 9-12 chunks for standard meeting transcripts.
    4. **Preserve Line Structure:** The \`refined_text\` for each chunk must maintain the original line breaks and start each line with a \`- \` prefix and end with "\\n" suffix to reflect the structure of the raw transcript.
    5. **Acknowledge Incomplete Context:** Be aware that the dialogue is part of an ongoing meeting. It may not have a complete beginning or end, and some parts might lack full context. Do not invent information to fill these gaps.
    6. **Acknowledge Multiple Speakers:** Understand that a single chunk of dialogue can contain lines from multiple people. The summary and refined text should reflect this conversational nature.
    7. **Do NOT Add Speaker Names:** The original transcript does not identify speakers, so you must not create or add any speaker names (e.g., 'Interviewer:', 'Speaker A:', etc.).
    8. **Summarize Each Chunk:** For each chunk, generate a very short, one-sentence summary.
    9. **Output JSON Format:** The final output must be a valid JSON array. Each object in the array must have two keys: \`summary\` (a single-sentence summary of the chunk), and \`refined_text\` (the cleaned dialogue with preserved line structure).
    
    Do NOT add any extra text or commentary outside of the JSON object. Just provide the JSON.
    
    Example of the REQUIRED output format:
    \`\`\`json
    [
      {
        "summary": "Discussion about the fear of AI's rapid progress.",
        "refined_text": "- Because of AI's rapid progress, do you fear anything today?\\n- I hope that we shape AI in a positive way. Its impact on being smarter than humans will change our world significantly, and it's definitely new territory."
      }
    ]
    \`\`\`
    `;

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

            const chatCompletion = await groq.chat.completions.create({
                "messages": [
                    {
                        "role": "system",
                        "content": sysPrompt
                    },
                    {
                        "role": "user",
                        "content": text
                    }
                ],
                // Model changed to the requested one
                "model": "openai/gpt-oss-120b",
                "temperature": 1,
                "max_completion_tokens": 8192,
                "top_p": 1,
                "stream": false,
                "reasoning_effort": "medium",
                "stop": null
            });

            const fullResponse = chatCompletion.choices[0]?.message?.content || '';
            const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);

            if (!jsonMatch) {
                console.warn(`CLEANING_LOG: No valid JSON array found on attempt ${attempt}. Retrying...`);
                // Continue to the next loop iteration for a retry
                continue;
            }

            const jsonString = jsonMatch[0];
            const parsedJson = JSON.parse(jsonString);

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