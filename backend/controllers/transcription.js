// transcription.js
const Groq = require('groq-sdk'); // Import the Groq SDK
const config = require('../utils/config'); // Import the centralized config

// Initialize the Groq client with the API key from config
const groq = new Groq({
    apiKey: config.GROQ_API_KEY,
});

const transcribe = async (audioBuffer, metadata = {}) => {
    try {
        if (!audioBuffer || !(audioBuffer instanceof Buffer)) {
            throw new Error('Audio data must be a Buffer.');
        }

        // You might want to use the original filename and mimetype from metadata for better API hints,
        // though Groq SDK often handles this gracefully even with just a Buffer.
        const fileOptions = {
            file: audioBuffer,
            // You can optionally add a filename hint to the SDK, e.g.:
            // fileName: metadata.originalFilename || `audio_${Date.now()}.${metadata.formatName || 'mp3'}`,
            // contentType: metadata.mimetype || 'audio/mpeg' // Fallback
        };

        const transcription = await groq.audio.transcriptions.create({
            ...fileOptions,
            model: "whisper-1", // Or "whisper-large-v3-turbo" as per Groq's latest models
            // response_format: "text", // default is json, which means {text: "..."}
            // language: "en", // Optionally specify language for better accuracy
        });

        if (!transcription || typeof transcription.text !== 'string') {
            throw new Error('Groq API did not return expected transcription text.');
        }

        return {
            success: true,
            transcription: transcription.text
        };
    } catch (error) {
        console.error('Groq Transcription API Error:', error.message);
        // Log more details if available from the SDK's error object
        if (error.status) console.error('HTTP Status:', error.status);
        if (error.headers) console.error('Headers:', error.headers);
        if (error.response) console.error('Response Data:', error.response.data);

        return {
            success: false,
            error: error.message || 'Unknown transcription error'
        };
    }
};

module.exports = {
    transcribe
};