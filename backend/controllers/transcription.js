const Groq = require('groq-sdk');
const config = require('../utils/config');
const { Readable } = require('stream'); // Import Readable stream
const path = require('path'); // Still useful for file extension logic

// Initialize the Groq client with the API key from config
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

        // Create a readable stream directly from the audioBuffer
        // This avoids writing the buffer to a temporary file on the server.
        const audioStream = Readable.from(audioBuffer);

        // Groq SDK expects the 'file' parameter to have a 'name' property
        // This name is used by the API to infer the file type.
        // We'll construct a dummy filename for the stream.
        const fileExtension = getFileExtension(metadata);
        const fileName = `audio_upload.${fileExtension}`; // Dummy filename for the stream
        Object.defineProperty(audioStream, 'name', { value: fileName, writable: false });

        console.log(`TRANSCRIPTION_LOG: Created in-memory stream with dummy filename: "${fileName}"`);

        const modelToUse = "whisper-large-v3"; // Use the correct model name
        console.log(`TRANSCRIPTION_LOG: Calling Groq API for transcription with model: "${modelToUse}"...`);
        
        // Pass the in-memory readable stream directly to the Groq API
        const transcription = await groq.audio.transcriptions.create({
            file: audioStream, // Pass the stream here
            model: modelToUse,
            response_format: "json",
            // language: "en", // Uncomment if you want to specify language
        });

        console.log('TRANSCRIPTION_LOG: Groq API call completed.');
        console.log('TRANSCRIPTION_LOG: Raw transcription response from Groq:', JSON.stringify(transcription, null, 2));

        if (!transcription || typeof transcription.text !== 'string') {
            console.error('TRANSCRIPTION_ERROR: Groq API did not return expected transcription text structure.');
            console.error('TRANSCRIPTION_ERROR: Actual response:', transcription);
            throw new Error('Groq API did not return expected transcription text.');
        }
        console.log('TRANSCRIPTION_LOG: Transcription text extracted successfully.');

        return {
            success: true,
            transcription: transcription.text,
            metadata: {
                duration: metadata.duration,
                originalName: metadata.originalname,
                processedAt: new Date().toISOString()
            }
        };

    } catch (error) {
        console.error('TRANSCRIPTION_ERROR: Groq Transcription API Error caught:');
        console.error('  Message:', error.message);
        console.error('  Error type:', error.constructor.name);
        
        // Log more details if available from the SDK's error object
        if (error.status) console.error('  HTTP Status:', error.status);
        if (error.code) console.error('  Error Code:', error.code);
        if (error.type) console.error('  Error Type:', error.type);
        
        // Handle different types of error responses
        if (error.error) {
            console.error('  API Error Details:', JSON.stringify(error.error, null, 2));
        }
        
        if (error.response) {
            console.error('  Response Status:', error.response.status);
            console.error('  Response Headers:', JSON.stringify(error.response.headers, null, 2));
            
            // Try to log response data safely
            try {
                if (typeof error.response.data === 'string') {
                    console.error('  Response Data:', error.response.data);
                } else {
                    console.error('  Response Data:', JSON.stringify(error.response.data, null, 2));
                }
            } catch (parseError) {
                console.error('  Response Data (unparseable):', error.response.data);
            }
        }
        
        console.error('  Error Stack:', error.stack);

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
        // No temporary file to clean up anymore!
        console.log('TRANSCRIPTION_LOG: Exiting transcribe function.');
    }
};

// Helper function to determine file extension from metadata
function getFileExtension(metadata) {
    if (metadata.formatName) {
        // Map format names to extensions
        const formatMap = {
            'mp3': 'mp3',
            'wav': 'wav',
            'flac': 'flac',
            'm4a': 'm4a',
            'ogg': 'ogg',
            'webm': 'webm'
        };
        return formatMap[metadata.formatName.toLowerCase()] || 'mp3';
    }
    
    if (metadata.originalname) {
        const ext = path.extname(metadata.originalname).slice(1).toLowerCase();
        return ext || 'mp3';
    }
    
    return 'mp3'; // Default fallback
}

module.exports = {
    transcribe
};
