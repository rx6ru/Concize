// workers/summaryWorker.js

require('dotenv').config();
const amqp = require('amqplib');
const config = require('../utils/config');
const { connectToMongo, getTranscription } = require('../db/mongoutils/transcription.db');
const { completeSummary } = require('../db/mongoutils/summary.db');
const { processSummaryUpdate } = require('../controllers/summaryService');

let channel, connection;

const startSummaryWorker = async () => {
    try {
        // 1. Connect to DB
        await connectToMongo();

        // 2. Connect to RabbitMQ
        connection = await amqp.connect(config.CLOUDAMQP_URL);
        channel = await connection.createChannel();

        // Assert queue
        await channel.assertQueue(config.SUMMARY_QUEUE, {
            durable: true // Ensure queue survives restarts
        });

        console.log(`Summary Worker waiting for messages in ${config.SUMMARY_QUEUE}...`);

        channel.prefetch(1); // Process one at a time per consumer to maintain order affinity if scaled (though strict order logic is in DB)

        // 3. Consume
        channel.consume(config.SUMMARY_QUEUE, async (msg) => {
            if (!msg) return;

            const { jobId, chunkIndex, isLastChunk } = JSON.parse(msg.content.toString());
            console.log(`Summary Worker: Received chunk ${chunkIndex} for ${jobId}`);

            try {
                // Step A: Validate Chunk Exists in MongoDB
                // Since we publish ONLY after confirmed write, this should usually succeed.
                // But replication lag or race conditions could technically happen.
                const transcriptionDoc = await getTranscription(jobId);

                if (!transcriptionDoc || !transcriptionDoc.transcriptionChunks || transcriptionDoc.transcriptionChunks.length <= chunkIndex) {
                    console.warn(`Summary Worker: Chunk ${chunkIndex} not found in DB for ${jobId}. Requeuing with delay...`);
                    // Nack with requeue=true, but effectively we might want a delay. 
                    // RabbitMQ doesn't have built-in delay without plugins. 
                    // Simple hack: wait locally then nack(true) or just publish to a delay exchange (too complex for now).
                    // We'll wait 2s blocking this consumer, then Requeue.
                    await new Promise(r => setTimeout(r, 2000));
                    channel.nack(msg, false, true);
                    return;
                }

                const rawText = transcriptionDoc.transcriptionChunks[chunkIndex];

                // Step B: Process Update
                await processSummaryUpdate(jobId, rawText, chunkIndex);

                // Step C: Finalize if last chunk
                if (isLastChunk) {
                    await completeSummary(jobId);
                }

                channel.ack(msg);
                console.log(`Summary Worker: Finished chunk ${chunkIndex} for ${jobId}`);

            } catch (error) {
                console.error(`Summary Worker: Failed processing ${jobId} chunk ${chunkIndex}:`, error.message);

                // If it's an "Out of order" error, we definitely want to retry (requeue).
                if (error.message.includes('Out of order')) {
                    console.log("Summary Worker: Requeuing out-of-order chunk...");
                    await new Promise(r => setTimeout(r, 2000)); // Simple backoff
                    channel.nack(msg, false, true);
                } else {
                    // For other errors (LLM failure, etc.), also retry for now.
                    // Ideally check retry count headers.
                    channel.nack(msg, false, false); // Dead letter (if configured) or just drop if no DLQ. 
                    // TODO: Configure DLQ argument in assertQueue for production safety.
                }
            }
        });

    } catch (error) {
        console.error('Summary Worker: Startup failed:', error);
        process.exit(1);
    }
};

// Graceful Shutdown
const gracefulShutdown = async () => {
    console.log('Summary Worker: Shutting down...');
    try {
        if (channel) await channel.close();
        if (connection) await connection.close();
        console.log('Summary Worker: Resources closed.');
        process.exit(0);
    } catch (err) {
        console.error('Summary Worker: Shutdown error:', err);
        process.exit(1);
    }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startSummaryWorker();
