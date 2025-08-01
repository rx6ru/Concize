// transcription.js
const Groq = require('groq-sdk');
const config = require('../utils/config');

const groq = new Groq({
    apiKey: config.GROQ_API_KEY,
});

const transcribe = async (audioBuffer, metadata = {}) => {
    console.log('TRANSCRIPTION_LOG: Entering transcribe function.');
    console.log('TRANSCRIPTION_LOG: Received audioBuffer type:', typeof audioBuffer);
    console.log('TRANSCRIPTION_LOG: Received metadata:', metadata);

    try {
        if (!audioBuffer || !(audioBuffer instanceof Buffer)) {
            console.error('TRANSCRIPTION_ERROR: Audio data is not a Buffer or is missing.');
            throw new Error('Audio data must be a Buffer.');
        }
        console.log('TRANSCRIPTION_LOG: Audio buffer validation passed. Buffer size:', audioBuffer.length, 'bytes.');

        const file = new File([audioBuffer], metadata.originalname, {
            type: metadata.mimetype,
        });
        console.log(`TRANSCRIPTION_LOG: Created in-memory File object with filename: "${file.name}"`);

        const modelToUse = "whisper-large-v3";
        console.log(`TRANSCRIPTION_LOG: Calling Groq API for transcription with model: "${modelToUse}"...`);
        
        // --- CHANGE: Use 'verbose_json' to get segmented output ---
        const transcription = await groq.audio.transcriptions.create({
            file: file,
            model: modelToUse,
            response_format: "verbose_json", // This provides a 'segments' array
            // language: "en",
        });

        console.log('TRANSCRIPTION_LOG: Groq API call completed.');
        
        if (!transcription || !transcription.segments || !Array.isArray(transcription.segments)) {
            console.error('TRANSCRIPTION_ERROR: Groq API did not return expected segmented response structure.');
            console.error('TRANSCRIPTION_ERROR: Actual response:', JSON.stringify(transcription, null, 2));
            throw new Error('Groq API did not return expected segmented transcription.');
        }

        // --- NEW LOGIC: Join the text from each segment with a newline ---
        const segmentedTranscription = transcription.segments.map(s => `- ${s.text.trim()}`).join('\n');
        console.log('TRANSCRIPTION_LOG: Transcription segments processed successfully.');

        return {
            success: true,
            transcription: segmentedTranscription,
            metadata: {
                duration: metadata.duration,
                originalName: metadata.originalname,
                processedAt: new Date().toISOString()
            }
        };

    } catch (error) {
        console.error('TRANSCRIPTION_ERROR: Groq Transcription API Error caught:');
        console.error('   Message:', error.message);
        console.error('   Error type:', error.constructor.name);
        
        if (error.status) console.error('   HTTP Status:', error.status);
        if (error.code) console.error('   Error Code:', error.code);
        if (error.type) console.error('   Error Type:', error.type);
        
        if (error.error) {
            console.error('   API Error Details:', JSON.stringify(error.error, null, 2));
        }
        
        if (error.response) {
            console.error('   Response Status:', error.response.status);
            console.error('   Response Headers:', JSON.stringify(error.response.headers, null, 2));
            
            try {
                if (typeof error.response.data === 'string') {
                    console.error('   Response Data:', error.response.data);
                } else {
                    console.error('   Response Data:', JSON.stringify(error.response.data, null, 2));
                }
            } catch (parseError) {
                console.error('   Response Data (unparseable):', error.response.data);
            }
        }
        
        console.error('   Error Stack:', error.stack);

        return {
            success: false,
            error: error.message || 'Unknown transcription error',
            errorType: error.constructor.name,
            errorDetails: {
                status: error.status,
                code: error.code,
                type: error.type
            }
        };

    } finally {
        console.log('TRANSCRIPTION_LOG: Exiting transcribe function.');
    }
};

module.exports = {
    transcribe
};