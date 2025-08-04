// worker.js
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');
const { transcribe } = require('./transcription');
const { clean } = require('./clean');
const { upsertTranscriptionChunks, createCollection } = require('./embed');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const { appendTranscription } = require('../db/mongoutil'); // Import the append function

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

const TRANSCRIPTION_DIR = './transcriptions'; // This might not be needed anymore, but keeping it for context

if (!fs.existsSync(TRANSCRIPTION_DIR)) {
    fs.mkdirSync(TRANSCRIPTION_DIR, { recursive: true });
}

let globalConnection = null;
let globalChannel = null;
let isWorkerRunning = false;

const startWorker = async () => {
    if (isWorkerRunning) {
        console.log('Worker: Attempted to start, but worker is already running.');
        return { success: true, message: 'Worker is already active.' };
    }

    try {
        console.log('Worker: Attempting to connect to RabbitMQ...');
        globalConnection = await amqp.connect(CLOUDAMQP_URL);
        globalChannel = await globalConnection.createChannel();

        globalConnection.on('close', (err) => {
            console.error('Worker: RabbitMQ connection closed unexpectedly:', err);
            isWorkerRunning = false;
            globalConnection = null;
            globalChannel = null;
        });
        globalChannel.on('close', (err) => {
            console.error('Worker: RabbitMQ channel closed unexpectedly:', err);
            isWorkerRunning = false;
            globalConnection = null;
            globalChannel = null;
        });

        await globalChannel.assertQueue(audioQueue, { durable: true });

        console.log('Worker: Initializing Qdrant collection...');
        await createCollection();

        console.log('Worker: Connected to RabbitMQ and waiting for audio transcription jobs...');

        globalChannel.prefetch(1);

        globalChannel.consume(audioQueue, async (msg) => {
            console.log('Worker: Received a message from the queue.');
            if (msg === null) {
                console.log('Worker: Consumer cancelled. No message received.');
                return;
            }

            let messageContent;
            let audioBuffer;
            let metadata;
            let audioFilePath;
            let jobId;

            try {
                const messageString = msg.content.toString();
                messageContent = JSON.parse(messageString);
                console.log('Worker: Message content parsed successfully.');

                // KEY CHANGE: Check for a termination signal
                if (messageContent.terminate === true) {
                    console.log(`Worker: Received termination signal for jobId: ${messageContent.jobId}. Shutting down gracefully.`);
                    // Acknowledge the termination message so it's removed from the queue
                    globalChannel.ack(msg);
                    await stopWorker(); // Gracefully close connections
                    return; // Stop processing further
                }
                
                // Get the jobId from the message
                jobId = messageContent.jobId;
                audioFilePath = messageContent.filePath;
                metadata = messageContent.metadata || {};
                console.log(`Worker: Received job for audio file at path: ${audioFilePath} for jobId: ${jobId}`);

                audioBuffer = fs.readFileSync(audioFilePath);
                console.log(`Worker: Audio buffer read from disk. Original file: ${metadata.originalname}`);

                console.log(`Worker: Processing transcription for: ${metadata.originalname || 'unknown file'}`);

                const transcribeResult = await transcribe(audioBuffer, metadata);
                if (!transcribeResult.success) {
                    throw new Error(`Transcription failed: ${transcribeResult.error}`);
                }
                const transcribedText = transcribeResult.transcription;

                // KEY CHANGE: Conditionally append the transcribed text to the MongoDB document
                if (transcribedText && transcribedText.trim().length > 0) {
                    const appendResult = await appendTranscription(jobId, transcribedText);
                    if (!appendResult) {
                        throw new Error(`Failed to append transcription to MongoDB for jobId: ${jobId}`);
                    }
                    console.log(`Worker: Transcription appended to MongoDB for jobId: ${jobId}`);
                } else {
                    console.warn(`Worker: No text to append for jobId: ${jobId}. Skipping database update.`);
                }

                // --- Embedding and clean logic can remain as it's separate from transcription storage ---
                const cleanedChunks = await clean(transcribedText);
                console.log(`Worker: Cleaned transcript into ${cleanedChunks.length} structured chunks.`);

                const embedResult = await upsertTranscriptionChunks(cleanedChunks, metadata);
                if (!embedResult.success) {
                    throw new Error(`Embedding and upsert failed: ${embedResult.error}`);
                }
                console.log(`Worker: Transcription processed and embedded successfully for "${metadata.originalname || 'unknown'}"`);
                // ----------------------------------------------------------------------------------

                // Clean up the processed audio file
                fs.unlink(audioFilePath, (unlinkErr) => {
                    if (unlinkErr) console.error(`Worker: Error deleting processed audio file ${audioFilePath}:`, unlinkErr);
                    else console.log(`Worker: Deleted processed audio file: ${audioFilePath}`);
                });

                globalChannel.ack(msg);
                console.log(`Worker: Acknowledged message for "${metadata.originalname || 'unknown'}"`);

            } catch (error) {
                console.error(`Worker: An error occurred during message processing for "${metadata.originalname || 'unknown'}"`);
                console.error('Worker: Error details:', error);

                if (audioFilePath && fs.existsSync(audioFilePath)) {
                    fs.unlink(audioFilePath, (unlinkErr) => {
                        if (unlinkErr) console.error(`Worker: Error deleting failed audio file ${audioFilePath}:`, unlinkErr);
                        else console.log(`Worker: Deleted failed audio file: ${audioFilePath}`);
                    });
                }

                globalChannel.nack(msg, false, false);
                console.error(`Worker: Nacked message for "${metadata.originalname || 'unknown'}" (requeued: false)`);
            }
        }, {
            noAck: false
        });

        isWorkerRunning = true;
        return { success: true, message: 'Worker started successfully.' };

    } catch (error) {
        console.error('Worker: Initialization or connection error:', error);
        if (globalConnection) {
            try { await globalConnection.close(); } catch (e) { console.error('Worker: Error closing connection during error:', e); }
        }
        globalConnection = null;
        globalChannel = null;
        isWorkerRunning = false;
        return { success: false, message: `Failed to start worker: ${error.message}` };
    }
};

const stopWorker = async () => {
    if (!isWorkerRunning) {
        console.log('Worker: Attempted to stop, but worker is not running.');
        return { success: true, message: 'Worker is already inactive.' };
    }
    
    try {
        if (globalChannel) {
            await globalChannel.close();
            console.log('Worker: RabbitMQ channel closed.');
        }
        if (globalConnection) {
            await globalConnection.close();
            console.log('Worker: RabbitMQ connection closed.');
        }
        isWorkerRunning = false;
        globalChannel = null;
        globalConnection = null;
        return { success: true, message: 'Worker stopped successfully.' };
    } catch (error) {
        console.error('Worker: Error while stopping the worker:', error);
        isWorkerRunning = false;
        globalChannel = null;
        globalConnection = null;
        return { success: false, message: `Failed to stop worker: ${error.message}` };
    }
};

const getWorkerStatus = () => {
    return {
        isRunning: isWorkerRunning
    };
};

module.exports = {
    startWorker,
    stopWorker,
    getWorkerStatus,
};
