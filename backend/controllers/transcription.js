// transcription.js
const Groq = require('groq-sdk');
const config = require('../utils/config');
const fs = require('fs');
const path = require('path');

// Initialize the Groq client with the API key from config
const groq = new Groq({
    apiKey: config.GROQ_API_KEY,
});

const transcribe = async (audioBuffer, metadata = {}) => {
    console.log('TRANSCRIPTION_LOG: Entering transcribe function.');
    console.log('TRANSCRIPTION_LOG: Received audioBuffer type:', typeof audioBuffer);
    console.log('TRANSCRIPTION_LOG: Received metadata:', metadata);

    let tempFilePath = null;

    try {
        if (!audioBuffer || !(audioBuffer instanceof Buffer)) {
            console.error('TRANSCRIPTION_ERROR: Audio data is not a Buffer or is missing.');
            throw new Error('Audio data must be a Buffer.');
        }
        console.log('TRANSCRIPTION_LOG: Audio buffer validation passed. Buffer size:', audioBuffer.length, 'bytes.');

        // Create a temporary file because Groq SDK expects a file path or readable stream
        const tempDir = './temp_audio';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileExtension = getFileExtension(metadata);
        const tempFileName = `temp_audio_${Date.now()}.${fileExtension}`;
        tempFilePath = path.join(tempDir, tempFileName);

        console.log('TRANSCRIPTION_LOG: Writing buffer to temporary file:', tempFilePath);
        fs.writeFileSync(tempFilePath, audioBuffer);

        console.log('TRANSCRIPTION_LOG: Temporary file created successfully.');

        const modelToUse = "whisper-large-v3"; // Use the correct model name
        console.log(`TRANSCRIPTION_LOG: Calling Groq API for transcription with model: "${modelToUse}"...`);
        
        // Create the transcription request with proper file handling
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
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
        // Clean up temporary file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log('TRANSCRIPTION_LOG: Temporary file deleted successfully.');
            } catch (unlinkError) {
                console.error('TRANSCRIPTION_ERROR: Failed to delete temporary file:', unlinkError.message);
            }
        }
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
            'webm': 'webm',
            'mp4': 'mp4',
            'mpeg': 'mp3',
            'mpga': 'mp3'
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