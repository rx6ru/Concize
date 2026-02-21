// services/transcriptionService.js
// Transcribes audio using the configured provider (Groq or Sarvam).
// Returns a unified TranscriptionResult contract.

'use strict';

const config = require('../configs/appConfig');
const groqService = require('../utils/llm/groqService');
const { normalizeGroqResult } = require('./transcription/groqNormalizer');
const { normalizeSarvamResult } = require('./transcription/sarvamNormalizer');
const { transcribeBatch } = require('./transcription/sarvamBatchProvider');
const { createFailureResult } = require('./transcription/transcriptionResult');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../utils/logger');

const logger = createLogger('transcriptionService');

/**
 * Transcribes audio using the configured provider.
 * Returns a unified TranscriptionResult regardless of provider.
 *
 * @param {Buffer} audioBuffer - The audio data as a Buffer
 * @param {Object} metadata - File metadata including originalFileName, mimetype, etc.
 * @returns {Promise<import('./transcription/transcriptionResult').TranscriptionResult>}
 */
async function transcribe(audioBuffer, metadata = {}) {
  const provider = config.inference.transcription.provider;
  logger.info('Entering transcribe', { provider, originalFileName: metadata.originalFileName });

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
    return createFailureResult(provider, 'Invalid audio buffer provided');
  }

  if (audioBuffer.length === 0) {
    return createFailureResult(provider, 'Empty audio buffer provided');
  }

  switch (provider) {
    case 'groq':
      return await transcribeWithGroq(audioBuffer, metadata);
    case 'sarvam':
      return await transcribeWithSarvam(audioBuffer, metadata);
    default:
      return createFailureResult(provider, `Unknown transcription provider: ${provider}`);
  }
}

/**
 * Transcribes audio using Groq's Whisper API with verbose_json format.
 * @param {Buffer} audioBuffer
 * @param {Object} metadata
 * @returns {Promise<import('./transcription/transcriptionResult').TranscriptionResult>}
 */
async function transcribeWithGroq(audioBuffer, metadata) {
  let tempFilePath = null;

  try {
    // Create a temporary file from the buffer
    const tempDir = os.tmpdir();
    const tempFileName = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.webm`;
    tempFilePath = path.join(tempDir, tempFileName);

    logger.debug('Writing buffer to temporary file', { tempFilePath });
    fs.writeFileSync(tempFilePath, audioBuffer);
    logger.debug('Temporary file created', { size: fs.statSync(tempFilePath).size });

    // Create file stream for Groq API
    const fileStream = fs.createReadStream(tempFilePath);
    const model = config.inference.transcription.model;

    logger.info('Calling Groq API for transcription', { model, format: 'verbose_json' });

    // Get rotated Groq client
    const groq = groqService.getClient();

    // Call Groq transcription API with verbose_json for rich metadata
    const groqResponse = await groq.audio.transcriptions.create({
      file: fileStream,
      model,
      response_format: 'verbose_json',  // Returns segments with timestamps + confidence
      temperature: 0.0,
      // Note: language intentionally omitted for auto-detection (multilingual support)
    });

    logger.info('Groq API response received', {
      segmentCount: groqResponse?.segments?.length || 0,
      language: groqResponse?.language,
    });

    // Normalize Groq response → unified TranscriptionResult
    const result = normalizeGroqResult(groqResponse);

    logger.info('Transcription completed', {
      provider: 'groq',
      language: result.language,
      segments: result.segments.length,
      textLength: result.transcription.length,
    });

    return result;

  } catch (error) {
    logger.error('Groq Transcription API Error', {
      message: error.message,
      type: error.constructor.name,
      status: error.status,
      details: error.error,
    });

    return createFailureResult('groq', error.message);

  } finally {
    // Clean up temporary file
    if (tempFilePath) {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          logger.debug('Temporary file cleaned up');
        }
      } catch (cleanupError) {
        logger.warn('Failed to clean up temp file', { error: cleanupError.message });
      }
    }
    logger.debug('Exiting transcribe function');
  }
}

/**
 * Transcribes audio using the Sarvam Batch API with diarization.
 * @param {Buffer} audioBuffer
 * @param {Object} metadata
 * @returns {Promise<import('./transcription/transcriptionResult').TranscriptionResult>}
 */
async function transcribeWithSarvam(audioBuffer, metadata) {
  try {
    logger.info('Calling Sarvam Batch API for transcription', {
      size: audioBuffer.length,
      originalFileName: metadata.originalFileName,
    });

    const sarvamResponse = await transcribeBatch(audioBuffer, metadata);

    const result = normalizeSarvamResult(sarvamResponse);

    logger.info('Sarvam transcription completed', {
      language: result.language,
      segments: result.segments.length,
      hasSpeakers: result.segments.some(s => s.speaker != null),
    });

    return result;

  } catch (error) {
    logger.error('Sarvam Transcription Error', {
      message: error.message,
      type: error.constructor.name,
    });
    return createFailureResult('sarvam', error.message);
  }
}

module.exports = { transcribe };