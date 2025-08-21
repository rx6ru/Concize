// controllers/transcription.js

const Groq = require("groq-sdk");
const config = require("../utils/config");
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Groq client
const groq = new Groq({
  apiKey: config.GROQ_API_KEY,
});

/**
 * Transcribes audio using Groq's Whisper API
 * @param {Buffer} audioBuffer - The audio data as a Buffer
 * @param {Object} metadata - File metadata including originalFileName, mimetype, etc.
 * @returns {Promise<{success: boolean, transcription?: string, error?: string}>}
 */
async function transcribe(audioBuffer, metadata = {}) {
  console.log("TRANSCRIPTION_LOG: Entering transcribe function.");

  try {
    // Validate inputs
    console.log("TRANSCRIPTION_LOG: Received audioBuffer type:", typeof audioBuffer);
    console.log("TRANSCRIPTION_LOG: Received metadata:", metadata);

    if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
      throw new Error("Invalid audio buffer provided");
    }

    if (audioBuffer.length === 0) {
      throw new Error("Empty audio buffer provided");
    }

    console.log(`TRANSCRIPTION_LOG: Audio buffer validation passed. Buffer size: ${audioBuffer.length} bytes.`);

    // Create a temporary file from the buffer
    const tempDir = os.tmpdir();
    const tempFileName = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.webm`;
    const tempFilePath = path.join(tempDir, tempFileName);

    console.log(`TRANSCRIPTION_LOG: Writing buffer to temporary file: ${tempFilePath}`);
    
    // Write buffer to temporary file
    fs.writeFileSync(tempFilePath, audioBuffer);
    
    console.log(`TRANSCRIPTION_LOG: Temporary file created. Size: ${fs.statSync(tempFilePath).size} bytes`);

    // Create file stream for Groq API
    const fileStream = fs.createReadStream(tempFilePath);

    console.log(`TRANSCRIPTION_LOG: Calling Groq API for transcription with model: "whisper-large-v3"...`);

    // Call Groq transcription API
    const transcription = await groq.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-large-v3",
      language: "en", // You can make this configurable
      response_format: "text",
      temperature: 0.0,
    });

    // Clean up temporary file
    try {
      fs.unlinkSync(tempFilePath);
      console.log("TRANSCRIPTION_LOG: Temporary file cleaned up successfully.");
    } catch (cleanupError) {
      console.warn("TRANSCRIPTION_WARNING: Failed to clean up temporary file:", cleanupError.message);
    }

    console.log("TRANSCRIPTION_LOG: Transcription completed successfully.");
    console.log(`TRANSCRIPTION_LOG: Transcription length: ${transcription?.length || 0} characters`);

    return {
      success: true,
      transcription: transcription || "",
    };

  } catch (error) {
    console.error("TRANSCRIPTION_ERROR: Groq Transcription API Error caught:");
    console.error("   Message:", error.message);
    console.error("   Error type:", error.constructor.name);
    
    if (error.status) {
      console.error("   HTTP Status:", error.status);
    }
    
    if (error.error) {
      console.error("   API Error Details:", error.error);
    }
    
    console.error("   Error Stack:", error.stack);

    // Clean up temporary file if it exists
    const tempDir = os.tmpdir();
    const possibleTempFiles = fs.readdirSync(tempDir).filter(file => 
      file.startsWith('audio_') && file.endsWith('.webm')
    );
    
    for (const tempFile of possibleTempFiles) {
      try {
        const tempFilePath = path.join(tempDir, tempFile);
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log(`TRANSCRIPTION_LOG: Cleaned up temporary file: ${tempFile}`);
        }
      } catch (cleanupError) {
        console.warn(`TRANSCRIPTION_WARNING: Failed to clean up temp file ${tempFile}:`, cleanupError.message);
      }
    }

    return {
      success: false,
      error: error.message,
    };
  } finally {
    console.log("TRANSCRIPTION_LOG: Exiting transcribe function.");
  }
}

module.exports = { transcribe };