

require('dotenv').config();
const amqp = require('amqplib');
const config = require('../core/config');
const { getTranscription } = require('../meetings/meeting.repository');
const { connectPg } = require('../infra/postgres');
const { completeSummary } = require('./summary.repository');
const { processSummaryUpdate } = require('./summary.service');
const { createLogger } = require('../core/logger');

const logger = createLogger('summaryWorker');

let channel, connection;

/** Handles one queue message. Extracted from the consume callback so its branches can be tested without standing up a broker. */
const handleMessage = async (channel, msg) => {
    if (!msg) return;

    const payload = JSON.parse(msg.content.toString());

    // Sent when a meeting ends. It rides the queue rather than being called directly so it lands after the last chunk, otherwise the chunk's save flips status back.
    if (payload.finalise) {
        try {
            await completeSummary(payload.jobId);
        } catch (err) {
            logger.error('Finalise failed', { jobId: payload.jobId, error: err.message });
        }
        channel.ack(msg);
        return;
    }

    const { jobId, chunkIndex, isLastChunk } = payload;
    logger.info('Received summary chunk', { jobId, chunkIndex, isLastChunk });

    try {
        // Published only after a confirmed write, so this should usually succeed; but replication lag or a race could still miss the chunk.
        const transcriptionDoc = await getTranscription(jobId);

        if (!transcriptionDoc || !transcriptionDoc.transcriptionChunks || transcriptionDoc.transcriptionChunks.length <= chunkIndex) {
            logger.warn('Chunk not found in DB, requeuing with delay', { jobId, chunkIndex });
            // Simple hack: RabbitMQ has no built-in delay without plugins, so we block this consumer 2s before requeuing.
            await new Promise(r => setTimeout(r, 2000));
            channel.nack(msg, false, true);
            return;
        }

        const rawText = transcriptionDoc.transcriptionChunks[chunkIndex];

        await processSummaryUpdate(jobId, rawText, chunkIndex);

        if (isLastChunk) {
            await completeSummary(jobId);
        }

        channel.ack(msg);
        logger.info('Finished processing chunk', { jobId, chunkIndex });

    } catch (error) {
        logger.error('Failed processing chunk', { jobId, chunkIndex, error: error.message });

        // Out-of-order errors are retried (requeued).
        if (error.message.includes('Out of order')) {
            logger.info("Requeuing out-of-order chunk", { jobId, chunkIndex });
            await new Promise(r => setTimeout(r, 2000)); // Simple backoff
            channel.nack(msg, false, true);
        } else {
            // Also retried for now, with no retry-count check; relies on a DLQ if one is configured.
            channel.nack(msg, false, false);
            // TODO: configure a DLQ in assertQueue for production.
        }
    }
};

const startSummaryWorker = async () => {
    try {
        await connectPg();

        connection = await amqp.connect(config.queues.CLOUDAMQP_URL);
        channel = await connection.createChannel();

        await channel.assertQueue(config.queues.SUMMARY_QUEUE, {
            durable: true // Ensure queue survives restarts
        });

        logger.info(`Summary Worker waiting for messages in ${config.queues.SUMMARY_QUEUE}`);

        channel.prefetch(1); // Process one at a time per consumer to maintain order affinity if scaled (though strict order logic is in DB)

        channel.consume(config.queues.SUMMARY_QUEUE, (msg) => handleMessage(channel, msg));

    } catch (error) {
        logger.error('Summary Worker startup failed', { error: error.message });
        process.exit(1);
    }
};

// Graceful Shutdown
const gracefulShutdown = async () => {
    logger.info('Summary Worker: Shutting down...');
    try {
        if (channel) {
            try {
                await channel.close();
            } catch (err) {
                if (err.message !== 'Channel closed' && err.message !== 'Channel closing') {
                    logger.error('Error closing channel', { error: err.message });
                }
            }
        }
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                if (err.message !== 'Connection closed' && err.message !== 'Connection closing') {
                    logger.error('Error closing connection', { error: err.message });
                }
            }
        }
        logger.info('Summary Worker: Resources closed.');
        process.exit(0);
    } catch (err) {
        logger.error('Summary Worker: Shutdown error', { error: err.message });
        process.exit(1);
    }
};

// Only attach when running directly (not imported)
if (require.main === module) {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    startSummaryWorker();
}

module.exports = { handleMessage };
