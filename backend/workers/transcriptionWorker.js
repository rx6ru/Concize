// workers/transcriptionWorker.js

const amqp = require("amqplib");
const { transcribe } = require("../services/transcriptionService");
const { clean } = require("../services/cleanService");
const { upsertTranscriptionChunks } = require("../services/embedding/transcriptionEmbedding");
const { createTranCollection } = require("../services/embedding/transcriptionEmbedding");
const { createChatCollection } = require("../services/embedding/chatEmbedding");
const { appendTranscription, getMeetingStatus } = require("../db/mongoutils/transcription.db");
const {
    fetchAudioFile,
    deleteAudioFile,
    initialiseCloudinary,
} = require("../db/cloudinary-utils/audio.db"); // Cloudinary utils
const { completeMeeting, completeMeetingWithErrors } = require("../services/meetingService");
const config = require("../configs/appConfig");
const { createLogger } = require("../utils/logger");

const logger = createLogger('transcriptionWorker');

const audioQueue = config.queues.AUDIO_QUEUE;
const CLOUDAMQP_URL = config.queues.CLOUDAMQP_URL;

let globalConnection = null;
let globalChannel = null;
let isShuttingDown = false; // Flag to prevent "unexpected close" logs during graceful exit


const startWorker = async () => {
    try {
        isShuttingDown = false; // Reset flag on start
        // Initialise Cloudinary once
        initialiseCloudinary();

        logger.info("Attempting to connect to RabbitMQ");
        globalConnection = await amqp.connect(CLOUDAMQP_URL);
        globalChannel = await globalConnection.createChannel();

        globalConnection.on("close", (err) => {
            if (!isShuttingDown) {
                logger.error("RabbitMQ connection closed unexpectedly", { error: err ? err.message : 'Unknown' });
            }
        });
        globalChannel.on("close", (err) => {
            if (!isShuttingDown) {
                logger.error("RabbitMQ channel closed unexpectedly", { error: err ? err.message : 'Unknown' });
            }
        });

        await globalChannel.assertQueue(audioQueue, { durable: true });

        logger.info("Initializing Qdrant collections");
        await createTranCollection();
        await createChatCollection();

        logger.info("Connected to RabbitMQ, waiting for jobs");
        globalChannel.prefetch(1);

        globalChannel.consume(
            audioQueue,
            async (msg) => {
                if (msg === null) {
                    logger.warn("Consumer cancelled, no message received");
                    return;
                }

                let messageContent;
                let fileId;
                let metadata = {};
                let jobId;
                let chunkProcessedSuccessfully = false; // Track processing outcome for last chunk handling

                try {
                    // Parse message
                    const messageString = msg.content.toString();
                    messageContent = JSON.parse(messageString);

                    jobId = messageContent.jobId;
                    fileId = messageContent.fileId; // Cloudinary publicId
                    metadata = messageContent.metadata || {};

                    logger.info('Processing job', { jobId, fileId });

                    // Ensure meeting is still active (skip if already finalized)
                    const meetingStatus = await getMeetingStatus(jobId);
                    if (meetingStatus === "completed" || meetingStatus === "completed_with_errors") {
                        logger.info('Skipping job, meeting finalized', { jobId, status: meetingStatus });
                        await deleteAudioFile(fileId);
                        globalChannel.ack(msg);
                        return;
                    }

                    // Fetch audio file from Cloudinary → returns Buffer
                    logger.debug('Fetching audio file from Cloudinary', { fileId });
                    const audioBuffer = await fetchAudioFile(fileId);
                    logger.debug('Audio buffer fetched', {
                        fileId,
                        size: audioBuffer.length,
                        originalName: metadata.originalFileName
                    });

                    // Transcribe
                    logger.info('Starting transcription', { originalName: metadata.originalFileName || 'unknown' });
                    const transcribeResult = await transcribe(audioBuffer, metadata);
                    if (!transcribeResult.success) {
                        throw new Error(`Transcription failed: ${transcribeResult.error}`);
                    }
                    const transcribedText = transcribeResult.transcription;
                    logger.info('Transcription completed', {
                        length: transcribedText?.length || 0,
                        jobId
                    });


                    // Save transcription
                    if (transcribedText && transcribedText.trim().length > 0) {
                        const appendResult = await appendTranscription(jobId, transcribedText);
                        if (!appendResult || !appendResult.success) {
                            throw new Error(
                                `Failed to append transcription to MongoDB for jobId: ${jobId}`
                            );
                        }
                        logger.debug('Transcription appended to MongoDB', { jobId });

                        // --- NEW: Publish to Summary Queue ---
                        try {
                            if (config.SUMMARY_QUEUE) {
                                await globalChannel.publish('', config.SUMMARY_QUEUE, Buffer.from(JSON.stringify({
                                    jobId,
                                    chunkIndex: appendResult.chunkIndex,
                                    isLastChunk: messageContent.isLastChunk
                                })));
                                logger.debug('Published to summaryQueue', { jobId, chunk: appendResult.chunkIndex });
                            }
                        } catch (pubError) {
                            logger.error('Failed to publish to summaryQueue', { jobId, error: pubError.message });
                        }

                    } else {
                        logger.warn('No text to append, skipping DB update', { jobId });
                    }

                    // Clean & Embed
                    if (transcribedText && transcribedText.trim().length > 0) {
                        logger.debug('Cleaning transcription text', { jobId });
                        const cleanedChunks = await clean(transcribedText);
                        logger.debug('Cleaned transcript', { chunks: cleanedChunks.length, jobId });

                        if (cleanedChunks.length > 0) {
                            logger.debug('Embedding chunks', { jobId });
                            const embedResult = await upsertTranscriptionChunks(
                                jobId,
                                cleanedChunks,
                                metadata
                            );
                            if (!embedResult.success) {
                                throw new Error(
                                    `Embedding and upsert failed: ${embedResult.error}`
                                );
                            }
                            logger.debug('Embedding completed', { jobId });
                        }
                    }

                    logger.info('Transcription job success', { jobId, originalName: metadata.originalFileName });

                    // Delete from Cloudinary
                    await deleteAudioFile(fileId);
                    logger.info('Deleted processed audio file', { fileId });

                    globalChannel.ack(msg);
                    logger.debug('Acknowledged message', { jobId });

                    chunkProcessedSuccessfully = true;

                } catch (error) {
                    logger.error('Worker processing error', {
                        jobId,
                        fileId,
                        originalName: metadata.originalFileName,
                        error: error.message
                    });

                    // Delete from Cloudinary even if failure
                    if (fileId) {
                        try {
                            await deleteAudioFile(fileId);
                            logger.info('Deleted failed job audio file', { fileId });
                        } catch (deleteError) {
                            logger.error('Failed to delete audio file for failed job', { fileId, error: deleteError.message });
                        }
                    }

                    // Don't requeue failed messages to prevent infinite loops
                    globalChannel.nack(msg, false, false);
                    logger.warn('Nacked message (no requeue)', { jobId });
                }

                // CRITICAL: Check for last chunk AFTER try-catch
                // Call appropriate completion function based on processing outcome
                if (messageContent && messageContent.isLastChunk && jobId) {
                    logger.info('Last chunk detected, initiating meeting completion', { jobId });
                    try {
                        if (chunkProcessedSuccessfully) {
                            await completeMeeting(jobId);
                        } else {
                            logger.warn('Last chunk failed processing, marking meeting with errors', { jobId });
                            await completeMeetingWithErrors(jobId);
                        }
                    } catch (completionError) {
                        logger.error('Failed to complete meeting', { jobId, error: completionError.message });
                    }
                }
            },
            {
                noAck: false,
            }
        );

        logger.info("Worker: Persistent worker started successfully.");
    } catch (error) {
        logger.error("Worker initialization error", { error: error.message });
        if (globalConnection) {
            try {
                await globalConnection.close();
            } catch (e) {
                logger.error("Error closing connection during error", { error: e.message });
            }
        }
        throw error; // Re-throw to allow restart logic
    }
};

// Graceful shutdown handler
const shutdown = async () => {
    logger.info("Worker: Shutting down gracefully...");
    isShuttingDown = true; // Mark as intentional shutdown
    try {
        if (globalChannel) {
            try {
                await globalChannel.close();
            } catch (err) {
                // Ignore errors if already closed or closing
                if (err.message !== 'Channel closed' && err.message !== 'Channel closing') {
                    logger.error("Error closing channel", { error: err.message });
                }
            }
        }
        if (globalConnection) {
            try {
                await globalConnection.close();
            } catch (err) {
                if (err.message !== 'Connection closed' && err.message !== 'Connection closing') {
                    logger.error("Error closing connection", { error: err.message });
                }
            }
        }
        logger.info("Worker shutdown complete");
    } catch (error) {
        logger.error("Error during shutdown", { error: error.message });
    }
};

// Export the shutdown function so the main process can call it
module.exports = {
    startWorker,
    shutdown,
};

// Graceful shutdown handler - Only attach if running directly
if (require.main === module) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    startWorker();
}
