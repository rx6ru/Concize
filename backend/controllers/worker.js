// worker.js
const amqp = require('amqplib');
const { transcribe } = require('./transcription'); // Your transcription service
const { clean } = require('./clean'); // Your cleaning service
const { upsertTranscriptionChunk, createCollection } = require('./embed'); // Import embedding and storage functions
const fs = require('fs');
const path = require('path');
const config = require('./utils/config'); // Your centralized config file

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

const TRANSCRIPTION_DIR = './transcriptions';

// Ensure the transcription directory exists upon worker module load
if (!fs.existsSync(TRANSCRIPTION_DIR)) {
    fs.mkdirSync(TRANSCRIPTION_DIR, { recursive: true });
}

// Global variables to hold connection and channel for external control
// These will be managed by the exported start/stop functions.
let globalConnection = null;
let globalChannel = null;
let isWorkerRunning = false; // To track the worker's operational state

/**
 * Establishes a connection to RabbitMQ, asserts the queue, and starts consuming messages.
 * This function should be called via the API endpoint (e.g., /api/worker/start).
 * @returns {object} An object indicating the success/failure of the operation and a message.
 */
const startWorker = async () => {
    if (isWorkerRunning) {
        console.log('Worker: Attempted to start, but worker is already running.');
        return { success: true, message: 'Worker is already active.' };
    }

    try {
        console.log('Worker: Attempting to connect to RabbitMQ...');
        globalConnection = await amqp.connect(CLOUDAMQP_URL);
        globalChannel = await globalConnection.createChannel();

        // Optional: Add event listeners for connection/channel closures for resilience
        globalConnection.on('close', (err) => {
            console.error('Worker: RabbitMQ connection closed unexpectedly:', err);
            isWorkerRunning = false; // Mark worker as stopped if connection drops
            globalConnection = null;
            globalChannel = null;
            // You might implement auto-reconnect logic here for production systems
        });
        globalChannel.on('close', (err) => {
            console.error('Worker: RabbitMQ channel closed unexpectedly:', err);
            isWorkerRunning = false; // Mark worker as stopped if channel drops
            globalConnection = null;
            globalChannel = null;
        });

        await globalChannel.assertQueue(audioQueue, { durable: true });
        
        // --- NEW: ENSURE QDRANT COLLECTION EXISTS ON WORKER STARTUP ---
        console.log('Worker: Initializing Qdrant collection...');
        await createCollection();

        console.log('Worker: Connected to RabbitMQ and waiting for audio transcription jobs...');

        // Set prefetch to limit the number of unacknowledged messages a consumer processes at once.
        // This helps in load balancing and prevents memory exhaustion for large messages.
        globalChannel.prefetch(1); // Process one message at a time

        // Start consuming messages from the queue
        globalChannel.consume(audioQueue, async (msg) => {
            if (msg === null) {
                // This typically happens if the consumer is cancelled by RabbitMQ (e.g., queue deleted)
                console.log('Worker: Consumer cancelled by RabbitMQ. Worker will stop if not re-connected.');
                isWorkerRunning = false; // Mark worker as stopped
                return;
            }

            let messageContent;
            let audioBuffer;
            let metadata;
            let transcriptionFileName;

            try {
                // Parse the message content
                messageContent = JSON.parse(msg.content.toString());

                // Reconstruct the audio buffer from the message
                if (messageContent.audioBufferData && messageContent.audioBufferData.type === 'Buffer' && Array.isArray(messageContent.audioBufferData.data)) {
                    audioBuffer = Buffer.from(messageContent.audioBufferData.data);
                } else {
                    throw new Error('Invalid audio buffer data received from queue.');
                }
                metadata = messageContent.metadata || {}; // Ensure metadata exists

                // Determine a unique filename for the transcription result
                transcriptionFileName = path.join(
                    TRANSCRIPTION_DIR,
                    `${metadata.uploadTimestamp ? metadata.uploadTimestamp.replace(/[:.]/g, '-') : `transcription_${Date.now()}`}.txt`
                );
                
                console.log(`Worker: Processing transcription for: ${metadata.originalname || 'unknown file'}`);

                // Step 1: Transcribe the audio
                const transcribeResult = await transcribe(audioBuffer, metadata);
                if (!transcribeResult.success) {
                    throw new Error(`Transcription failed: ${transcribeResult.error}`);
                }
                const transcribedText = transcribeResult.transcription;

                // Step 2: Clean the transcribed text
                const refinedText = await clean(transcribedText);

                // Step 3: Embed the cleaned text and upsert to Qdrant
                // Use a unique ID for the point. The filename is a good candidate.
                const pointId = path.basename(transcriptionFileName, '.txt');
                const embedResult = await upsertTranscriptionChunk(pointId, refinedText, metadata);
                if (!embedResult.success) {
                    throw new Error(`Embedding and upsert failed: ${embedResult.error}`);
                }
                
                console.log(`Worker: Transcription processed and embedded successfully for "${metadata.originalname || 'unknown'}": ${refinedText.substring(0, 50)}...`);

                // Step 4: Append the FINAL result to the local file
                const textToAppend = `[${new Date().toISOString()}] (Original: ${metadata.originalname || 'N/A'}) \n${refinedText}\n---\n`;
                fs.appendFile(transcriptionFileName, textToAppend, (err) => {
                    if (err) {
                        console.error(`Worker: Error appending transcription to file ${transcriptionFileName}:`, err);
                    } else {
                        console.log(`Worker: Transcription appended to ${transcriptionFileName}`);
                    }
                });

                // Step 5: Acknowledge the message ONLY AFTER all steps are complete
                globalChannel.ack(msg); 
                console.log(`Worker: Acknowledged message for "${metadata.originalname || 'unknown'}"`);

            } catch (error) {
                console.error(`Worker: Error processing message for "${metadata.originalname || 'unknown'}":`, error);
                // Nack the message and requeue it for retry (or move to a dead-letter queue in production)
                globalChannel.nack(msg, false, true); // `false` for multiple, `true` to requeue
                console.error(`Worker: Nacked message for "${metadata.originalname || 'unknown'}" (requeued: true)`);
            }
        }, {
            noAck: false // Crucial: Enable manual acknowledgments for reliable message processing
        });

        isWorkerRunning = true; // Update worker state
        return { success: true, message: 'Worker started successfully.' };

    } catch (error) {
        console.error('Worker: Initialization or connection error:', error);
        // Clean up any open connections if an error occurs during startup
        if (globalConnection) {
            try { await globalConnection.close(); } catch (e) { console.error('Worker: Error closing connection during error:', e); }
        }
        globalConnection = null;
        globalChannel = null;
        isWorkerRunning = false; // Mark worker as not running
        return { success: false, message: `Failed to start worker: ${error.message}` };
    }
};

/**
 * Stops the RabbitMQ consumer worker by closing its connection and channel.
 * This function should be called via the API endpoint (e.g., /api/worker/stop).
 * @returns {object} An object indicating the success/failure of the operation and a message.
 */
const stopWorker = async () => {
    if (!isWorkerRunning) {
        console.log('Worker: Attempted to stop, but worker is not running.');
        return { success: true, message: 'Worker not active.' };
    }

    console.log('Worker: Attempting to stop worker and close RabbitMQ connections...');
    try {
        if (globalChannel) {
            // Closing the channel or connection will automatically cancel consumers
            await globalChannel.close();
            console.log('Worker: RabbitMQ channel closed.');
        }
        if (globalConnection) {
            await globalConnection.close();
            console.log('Worker: RabbitMQ connection closed.');
        }
        globalChannel = null;
        globalConnection = null;
        isWorkerRunning = false; // Update worker state
        console.log('Worker: Stopped successfully.');
        return { success: true, message: 'Worker stopped successfully.' };
    } catch (error) {
        console.error('Worker: Error stopping worker:', error);
        return { success: false, message: `Error stopping worker: ${error.message}` };
    }
};

/**
 * Retrieves the current operational status of the worker.
 * @returns {object} An object with `isRunning` boolean and connection/channel status.
 */
const getWorkerStatus = () => {
    return {
        isRunning: isWorkerRunning,
        connectionStatus: globalConnection ? 'connected' : 'disconnected',
        channelStatus: globalChannel ? 'open' : 'closed',
    };
};

// Export these functions so they can be imported and called by other modules (like meetingRoutes.js)
module.exports = {
    startWorker,
    stopWorker,
    getWorkerStatus,
};