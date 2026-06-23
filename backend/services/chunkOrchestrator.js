// services/chunkOrchestrator.js
// Extracted pipeline logic — handles the transcribe → pre-chunk → clean → embed flow.
// The worker only dequeues, calls this, and acks.

'use strict';

const { transcribe } = require('./transcriptionService');
const { preChunkSegments } = require('./preChunker');
const { clean } = require('./cleanService');
const { upsertTranscriptionChunks } = require('./embedding/transcriptionEmbedding');
const { appendTranscription } = require('../db/queries/transcription.db');
const { createLogger } = require('../utils/logger');

const logger = createLogger('chunkOrchestrator');

/**
 * Processes a single audio chunk through the full pipeline:
 * transcribe → store raw → pre-chunk → clean (narrative) → embed into Qdrant.
 *
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {Object} metadata - File/upload metadata (originalFileName, mimetype, etc.)
 * @param {string} jobId - Meeting job ID
 * @param {string} ownerId - Owning user id (stamped onto the Qdrant payload for tenant isolation)
 * @returns {Promise<{
 *   success: boolean,
 *   transcription: string,
 *   chunkIndex: number,
 *   cleanedChunkCount: number,
 *   error?: string,
 * }>}
 */
async function processAudioChunk(audioBuffer, metadata, jobId, ownerId) {
    // Step 1: Transcribe
    logger.info('Step 1: Transcribing audio', { jobId });
    const result = await transcribe(audioBuffer, metadata);

    if (!result.success) {
        return {
            success: false,
            transcription: '',
            chunkIndex: -1,
            cleanedChunkCount: 0,
            error: `Transcription failed: ${result.error}`,
        };
    }

    const hasSpeakers = result.segments.some(s => s.speaker != null);

    // Apply global time offset if provided by the frontend
    const audioOffset = metadata.audioOffset || 0;
    if (audioOffset > 0 && result.segments && result.segments.length > 0) {
        logger.debug('Applying global time offset to segments', { jobId, audioOffset });
        result.segments.forEach(segment => {
            if (segment.startTime != null) segment.startTime += audioOffset;
            if (segment.endTime != null) segment.endTime += audioOffset;
        });
    }

    logger.info('Transcription succeeded', {
        jobId,
        provider: result.provider,
        language: result.language,
        segments: result.segments.length,
        hasSpeakers,
    });

    // Step 2: Store raw transcription in MongoDB (structured)
    let chunkIndex = -1;
    if (result.transcription && result.transcription.trim()) {
        logger.info('Step 2: Storing raw transcription in MongoDB', { jobId });

        const mongoData = {
            text: result.transcription,
            segments: result.segments,
            provider: result.provider,
            language: result.language,
        };

        const appendResult = await appendTranscription(jobId, mongoData);
        if (!appendResult || !appendResult.success) {
            return {
                success: false,
                transcription: result.transcription,
                chunkIndex: -1,
                cleanedChunkCount: 0,
                error: `Failed to append transcription to MongoDB for jobId: ${jobId}`,
            };
        }
        chunkIndex = appendResult.chunkIndex;
        logger.info('Raw transcription stored', { jobId, chunkIndex });
    } else {
        logger.warn('No transcription text to store', { jobId });
        return {
            success: true,
            transcription: '',
            chunkIndex: -1,
            cleanedChunkCount: 0,
        };
    }

    // Step 3: Pre-chunk segments into structural groups
    logger.info('Step 3: Pre-chunking segments', { jobId });
    const preChunked = preChunkSegments(result);
    logger.info('Pre-chunked', { jobId, chunks: preChunked.length });

    // Step 4: Clean each pre-chunk → produce narrative + summary + mentionedNames
    if (preChunked.length === 0) {
        logger.warn('No pre-chunks produced, skipping clean/embed', { jobId });
        return { success: true, transcription: result.transcription, chunkIndex, cleanedChunkCount: 0 };
    }

    // Build the text to send to the clean LLM (one call for all pre-chunks)
    const textForCleaning = preChunked.map((chunk, i) => {
        const speakerInfo = chunk.speakers.length > 0
            ? `[Speakers: ${chunk.speakers.join(', ')}] ` : '';
        return `--- Chunk ${i + 1} ---\n${speakerInfo}${chunk.text}`;
    }).join('\n\n');

    logger.info('Step 4: Cleaning transcription', { jobId, hasSpeakers });
    const cleanContext = {
        hasSpeakers,
        provider: result.provider,
    };
    const cleaned = await clean(textForCleaning, cleanContext);
    logger.info('Cleaning done', { jobId, narrativeChunks: cleaned.length });

    // Step 5: Embed narratives into Qdrant with enriched metadata
    if (cleaned.length > 0) {
        logger.info('Step 5: Embedding into Qdrant', { jobId, chunks: cleaned.length });

        // Merge all speakers and time ranges from pre-chunks
        const allSpeakers = [...new Set(preChunked.flatMap(c => c.speakers))];
        const startTime = preChunked[0]?.startTime ?? 0;
        const endTime = preChunked[preChunked.length - 1]?.endTime ?? 0;

        const enrichedMetadata = {
            ...metadata,
            ownerId,
            startTime,
            endTime,
            speakers: allSpeakers,
            provider: result.provider,
            language: result.language,
            chunkIndex,
        };

        const embedResult = await upsertTranscriptionChunks(jobId, cleaned, enrichedMetadata);
        if (!embedResult.success) {
            return {
                success: false,
                transcription: result.transcription,
                chunkIndex,
                cleanedChunkCount: cleaned.length,
                error: `Embedding failed: ${embedResult.error}`,
            };
        }
        logger.info('Embedding completed', { jobId, upserted: cleaned.length });
    }

    return {
        success: true,
        transcription: result.transcription,
        chunkIndex,
        cleanedChunkCount: cleaned.length,
    };
}

module.exports = { processAudioChunk };
