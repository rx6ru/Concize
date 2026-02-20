// services/transcriptionService.js

const config = require("../configs/appConfig");
const groqService = require("../utils/llm/groqService");
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../utils/logger');

const logger = createLogger('transcriptionService');

/**
 * Transcribes audio using Groq's Whisper API
 * @param {Buffer} audioBuffer - The audio data as a Buffer
 * @param {Object} metadata - File metadata including originalFileName, mimetype, etc.
 * @returns {Promise<{success: boolean, transcription?: string, error?: string}>}
 */
async function transcribe(audioBuffer, metadata = {}) {
  logger.info("Entering transcribe function", { originalFileName: metadata.originalFileName });

  // Declare tempFilePath outside try so it's accessible in catch for cleanup
  let tempFilePath = null;

  try {
    // Validate inputs
    logger.debug("Received audioBuffer", { type: typeof audioBuffer, metadata });

    if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
      throw new Error("Invalid audio buffer provided");
    }

    if (audioBuffer.length === 0) {
      throw new Error("Empty audio buffer provided");
    }

    logger.debug("Audio buffer validation passed", { size: audioBuffer.length });

    // Create a temporary file from the buffer
    const tempDir = os.tmpdir();
    const tempFileName = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.webm`;
    tempFilePath = path.join(tempDir, tempFileName);

    logger.debug("Writing buffer to temporary file", { tempFilePath });

    // Write buffer to temporary file
    fs.writeFileSync(tempFilePath, audioBuffer);

    logger.debug("Temporary file created", { size: fs.statSync(tempFilePath).size });

    // Create file stream for Groq API
    const fileStream = fs.createReadStream(tempFilePath);

    logger.info("Calling Groq API for transcription", { model: "whisper-large-v3" });

    // Get rotated Groq client
    const groq = groqService.getClient();

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
      logger.debug("Temporary file cleaned up successfully");
    } catch (cleanupError) {
      logger.warn("Failed to clean up temporary file", { error: cleanupError.message });
    }

    logger.info("Transcription completed successfully", { length: transcription?.length || 0 });

    return {
      success: true,
      transcription: transcription || "",
    };

  } catch (error) {
    logger.error("Groq Transcription API Error", {
      message: error.message,
      type: error.constructor.name,
      status: error.status,
      details: error.error,
      stack: error.stack
    });

    // Clean up THIS request's temporary file only (not all audio_*.webm files)
    if (tempFilePath) {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          logger.info("Cleaned up temporary file after error", { tempFilePath });
        }
      } catch (cleanupError) {
        logger.warn("Failed to clean up temp file after error", { error: cleanupError.message });
      }
    }

    return {
      success: false,
      error: error.message,
    };
  } finally {
    logger.debug("Exiting transcribe function");
  }
}

module.exports = { transcribe };