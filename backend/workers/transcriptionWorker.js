// workers/transcriptionWorker.js
// Thin worker — dequeues audio jobs, delegates to chunkOrchestrator, acks/nacks.

'use strict';

const amqp = require('amqplib');
const { processAudioChunk } = require('../services/chunkOrchestrator');
const { createTranCollection } = require('../services/embedding/transcriptionEmbedding');
const { createChatCollection } = require('../services/embedding/chatEmbedding');
const {
    fetchAudioFile,
    deleteAudioFile,
    initialiseCloudinary,
} = require('../db/cloudinary-utils/audio.db');
const { getMeetingStatus } = require('../db/mongoutils/transcription.db');
const { completeMeeting, completeMeetingWithErrors } = require('../services/meetingService');
const config = require('../configs/appConfig');
const { createLogger } = require('../utils/logger');

const logger = createLogger('transcriptionWorker');

const audioQueue = config.queues.AUDIO_QUEUE;
const CLOUDAMQP_URL = config.queues.CLOUDAMQP_URL;

let globalConnection = null;
let globalChannel = null;
let isShuttingDown = false;

const startWorker = async () => {
    try {
        isShuttingDown = false;
        initialiseCloudinary();

        logger.info('Attempting to connect to RabbitMQ');
        globalConnection = await amqp.connect(CLOUDAMQP_URL);
        globalChannel = await globalConnection.createChannel();

        globalConnection.on('close', (err) => {
            if (!isShuttingDown) {
                logger.error('RabbitMQ connection closed unexpectedly', { error: err ? err.message : 'Unknown' });
            }
        });
        globalChannel.on('close', (err) => {
            if (!isShuttingDown) {
                logger.error('RabbitMQ channel closed unexpectedly', { error: err ? err.message : 'Unknown' });
            }
        });

        await globalChannel.assertQueue(audioQueue, { durable: true });

        logger.info('Initializing Qdrant collections');
        await createTranCollection();
        await createChatCollection();

        logger.info('Connected to RabbitMQ, waiting for jobs');
        globalChannel.prefetch(1);

        globalChannel.consume(
            audioQueue,
            async (msg) => {
                if (msg === null) {
                    logger.warn('Consumer cancelled, no message received');
                    return;
                }

                let messageContent;
                let fileId;
                let metadata = {};
                let jobId;
                let chunkProcessedSuccessfully = false;

                try {
                    // Parse message
                    messageContent = JSON.parse(msg.content.toString());
                    jobId = messageContent.jobId;
                    fileId = messageContent.fileId;
                    metadata = messageContent.metadata || {};

                    logger.info('Processing job', { jobId, fileId });

                    // Skip if meeting already finalized
                    const meetingStatus = await getMeetingStatus(jobId);
                    if (meetingStatus === 'completed' || meetingStatus === 'completed_with_errors') {
                        logger.info('Skipping job, meeting finalized', { jobId, status: meetingStatus });
                        await deleteAudioFile(fileId);
                        globalChannel.ack(msg);
                        return;
                    }

                    // Fetch audio from Cloudinary
                    logger.debug('Fetching audio file', { fileId });
                    const audioBuffer = await fetchAudioFile(fileId);
                    logger.debug('Audio buffer fetched', { fileId, size: audioBuffer.length });

                    // === DELEGATE TO ORCHESTRATOR ===
                    const result = await processAudioChunk(audioBuffer, metadata, jobId);

                    if (!result.success) {
                        throw new Error(result.error || 'Orchestrator returned failure');
                    }

                    // Publish to summary queue if text was produced
                    if (result.transcription && result.chunkIndex >= 0) {
                        try {
                            if (config.queues.SUMMARY_QUEUE) {
                                await globalChannel.sendToQueue(
                                    config.queues.SUMMARY_QUEUE,
                                    Buffer.from(JSON.stringify({
                                        jobId,
                                        chunkIndex: result.chunkIndex,
                                        isLastChunk: messageContent.isLastChunk,
                                    })),
                                );
                                logger.debug('Published to summaryQueue', { jobId, chunk: result.chunkIndex });
                            }
                        } catch (pubError) {
                            logger.error('Failed to publish to summaryQueue', { jobId, error: pubError.message });
                        }
                    }

                    logger.info('Job success', {
                        jobId,
                        cleanedChunks: result.cleanedChunkCount,
                        originalName: metadata.originalFileName,
                    });

                    // Clean up Cloudinary
                    await deleteAudioFile(fileId);
                    logger.info('Deleted processed audio file', { fileId });

                    globalChannel.ack(msg);
                    chunkProcessedSuccessfully = true;

                } catch (error) {
                    logger.error('Worker processing error', {
                        jobId,
                        fileId,
                        originalName: metadata?.originalFileName,
                        error: error.message,
                    });

                    // Delete audio even on failure
                    if (fileId) {
                        try {
                            await deleteAudioFile(fileId);
                            logger.info('Deleted failed job audio file', { fileId });
                        } catch (deleteError) {
                            logger.error('Failed to delete audio file for failed job', { fileId, error: deleteError.message });
                        }
                    }

                    globalChannel.nack(msg, false, false);
                    logger.warn('Nacked message (no requeue)', { jobId });
                }

                // Meeting completion check (AFTER try-catch)
                if (messageContent && messageContent.isLastChunk && jobId) {
                    logger.info('Last chunk detected, initiating meeting completion', { jobId });
                    try {
                        if (chunkProcessedSuccessfully) {
                            await completeMeeting(jobId);
                        } else {
                            logger.warn('Last chunk failed, marking meeting with errors', { jobId });
                            await completeMeetingWithErrors(jobId);
                        }
                    } catch (completionError) {
                        logger.error('Failed to complete meeting', { jobId, error: completionError.message });
                    }
                }
            },
            { noAck: false }
        );

        logger.info('Worker: Persistent worker started successfully.');
    } catch (error) {
        logger.error('Worker initialization error', { error: error.message });
        if (globalConnection) {
            try {
                await globalConnection.close();
            } catch (e) {
                logger.error('Error closing connection during error', { error: e.message });
            }
        }
        throw error;
    }
};

// Graceful shutdown handler
const shutdown = async () => {
    logger.info('Worker: Shutting down gracefully...');
    isShuttingDown = true;
    try {
        if (globalChannel) {
            try {
                await globalChannel.close();
            } catch (err) {
                if (err.message !== 'Channel closed' && err.message !== 'Channel closing') {
                    logger.error('Error closing channel', { error: err.message });
                }
            }
        }
        if (globalConnection) {
            try {
                await globalConnection.close();
            } catch (err) {
                if (err.message !== 'Connection closed' && err.message !== 'Connection closing') {
                    logger.error('Error closing connection', { error: err.message });
                }
            }
        }
        logger.info('Worker shutdown complete');
    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
    }
};

module.exports = { startWorker, shutdown };

// Graceful shutdown handler - Only attach if running directly
if (require.main === module) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    startWorker();
}
