// clean.js
const Groq = require('groq-sdk');
const config = require('../utils/config');

// Initialize Groq SDK with API key from a config file
const groq = new Groq({
    apiKey: config.GROQ_API_KEY,
});

/**
 * Processes a raw text transcript, refining it and converting it into a
 * structured JSON array of dialogue chunks.
 * * @param {string} text The raw, unrefined transcript text.
 * @returns {Promise<Array>} A promise that resolves to a parsed JSON array
 * containing the structured and refined dialogue.
 */
const clean = async (text) => {
    try {
        let fullResponse = '';

        // Create a streaming chat completion with the Groq API
        const chatCompletion = await groq.chat.completions.create({
            "messages": [
                {
                    "role": "system",
                    "content": `You are a text processor for a video conference transcription. Your task is to refine, chunk, and summarize the provided unrefined transcript. The output MUST be a JSON array of objects. Each object in the array represents a single, semantically coherent chunk of the dialogue.
    
                    Here are the specific rules you must follow:
                    1.  **Refine the Dialogue:** Correct grammar, remove filler words (e.g., 'you know,' 'like,' 'um,' 'ah'), and strip out any unnecessary or non-dialogue text.
                    2.  **Chunk the Dialogue:** Break the refined dialogue into small, logical chunks, typically based on a change in topic or a pause in the conversation.
                    3.  **Preserve Line Structure:** The \`refined_text\` for each chunk must maintain the original line breaks and start each line with a \`- \` prefix and end with "\\n" suffix to reflect the structure of the raw transcript.
                    4.  **Acknowledge Incomplete Context:** Be aware that the dialogue is part of an ongoing meeting. It may not have a complete beginning or end, and some parts might lack full context. Do not invent information to fill these gaps.
                    5.  **Acknowledge Multiple Speakers:** Understand that a single chunk of dialogue can contain lines from multiple people. The summary and refined text should reflect this conversational nature.
                    6.  **Do NOT Add Speaker Names:** The original transcript does not identify speakers, so you must not create or add any speaker names (e.g., 'Interviewer:', 'Speaker A:', etc.).
                    7.  **Summarize Each Chunk:** For each chunk, generate a very short, one-sentence summary.
                    8.  **Output JSON Format:** The final output must be a valid JSON array. Each object in the array must have two keys: \`summary\` (a single-sentence summary of the chunk), and \`refined_text\` (the cleaned dialogue with preserved line structure).
    
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
                    `
                },
                {
                    "role": "user",
                    "content": text
                }
            ],
            "model": "qwen/qwen3-32b",
            "temperature": 0.6,
            "max_completion_tokens": 4096,
            "top_p": 0.95,
            "stream": true,
            "reasoning_effort": "default",
            "stop": null
        });

        // Collect the full streaming response into a single string
        for await (const chunk of chatCompletion) {
            fullResponse += chunk.choices[0]?.delta?.content || '';
        }

        // Use a regular expression to find and extract the JSON array
        // This is robust to any leading/trailing commentary from the model.
        const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            throw new Error('No valid JSON array found in response');
        }

        const jsonString = jsonMatch[0];

        // Parse the extracted JSON string to validate it and convert it to an object
        const parsedJson = JSON.parse(jsonString);

        // Return the parsed JSON object directly, as the LLM is now instructed
        // to provide the desired format without the 'chunk_index'.
        return parsedJson;

    } catch (e) {
        console.error('Error during transcription cleaning:', e);
        // Rethrow the error to be handled by the caller
        throw e;
    }
};

module.exports = { clean };
