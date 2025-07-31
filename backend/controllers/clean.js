// clean.js
const Groq = require('groq-sdk');
const config = require('../utils/config');

const groq = new Groq({
    apiKey: config.GROQ_API_KEY,
});

const clean = async (text) => {
    try {
        const chatCompletion = await groq.chat.completions.create({
            "messages": [
                {
                    "role": "system",
                    "content": "You are provided the transcription of a small part of the video conference. Refine the dialogues by removing extra languages/English grammar and other non-sense words. The output should be in English. Also, note - as this will just be part of the conference so it may lack context or may have incomplete context, so refine accordingly without generating any new context or any random/garbage context."
                },
                {
                    "role": "user",
                    "content": text
                }
            ],
            "model": "compound-beta-mini",
            "temperature": 1,
            "max_completion_tokens": 1024,
            "top_p": 1,
            // We set stream to false to get the full response at once.
            // This is the simplest way to make it work with your worker.js logic.
            "stream": false, 
            "stop": null
        });

        // The response for stream: false is a single object
        const refinedText = chatCompletion.choices[0]?.message?.content || '';
        return refinedText;

    } catch (e) {
        console.error('Error during transcription cleaning:', e);
        // It's good practice to return a value, even on error.
        // Returning the original text allows downstream processes to continue.
        return text; 
    }
};

module.exports = { clean };