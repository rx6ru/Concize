// worker.js

const amqp = require('amqplib');
const { transcribe } = require('./transcription');
const { clean } = require('./clean');
const { upsertTranscriptionChunks, createCollection } = require('./embed');
const fs = require('fs');
const config = require('../utils/config');
const { appendTranscription, getMeetingStatus } = require('../db/mongoutil'); // Import getMeetingStatus

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

let globalConnection = null;
let globalChannel = null;

const startWorker = async () => {
    try {
        console.log('Worker: Attempting to connect to RabbitMQ...');
        globalConnection = await amqp.connect(CLOUDAMQP_URL);
        globalChannel = await globalConnection.createChannel();

        globalConnection.on('close', (err) => {
            console.error('Worker: RabbitMQ connection closed unexpectedly:', err);
        });
        globalChannel.on('close', (err) => {
            console.error('Worker: RabbitMQ channel closed unexpectedly:', err);
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

                jobId = messageContent.jobId;
                audioFilePath = messageContent.filePath;
                metadata = messageContent.metadata || {};

                // KEY CHANGE: Check if the meeting for this jobId is still active before processing.
                const meetingStatus = await getMeetingStatus(jobId);
                if (meetingStatus === 'completed') {
                    console.log(`Worker: Skipping job for jobId ${jobId}. Meeting is already completed.`);
                    fs.unlink(audioFilePath, (unlinkErr) => {
                        if (unlinkErr) console.error(`Worker: Error deleting completed job's audio file ${audioFilePath}:`, unlinkErr);
                        else console.log(`Worker: Deleted completed job's audio file: ${audioFilePath}`);
                    });
                    globalChannel.ack(msg);
                    return;
                }

                console.log(`Worker: Received job for audio file at path: ${audioFilePath} for jobId: ${jobId}`);
                
                audioBuffer = fs.readFileSync(audioFilePath);
                console.log(`Worker: Audio buffer read from disk. Original file: ${metadata.originalname}`);

                console.log(`Worker: Processing transcription for: ${metadata.originalname || 'unknown file'}`);
                const transcribeResult = await transcribe(audioBuffer, metadata);
                if (!transcribeResult.success) {
                    throw new Error(`Transcription failed: ${transcribeResult.error}`);
                }
                const transcribedText = transcribeResult.transcription;

                if (transcribedText && transcribedText.trim().length > 0) {
                    const appendResult = await appendTranscription(jobId, transcribedText);
                    if (!appendResult) {
                        throw new Error(`Failed to append transcription to MongoDB for jobId: ${jobId}`);
                    }
                    console.log(`Worker: Transcription appended to MongoDB for jobId: ${jobId}`);
                } else {
                    console.warn(`Worker: No text to append for jobId: ${jobId}. Skipping database update.`);
                }

                const cleanedChunks = await clean(transcribedText);
                console.log(`Worker: Cleaned transcript into ${cleanedChunks.length} structured chunks.`);

                const embedResult = await upsertTranscriptionChunks(cleanedChunks, metadata);
                if (!embedResult.success) {
                    throw new Error(`Embedding and upsert failed: ${embedResult.error}`);
                }
                console.log(`Worker: Transcription processed and embedded successfully for "${metadata.originalname || 'unknown'}"`);

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

    } catch (error) {
        console.error('Worker: Initialization or connection error:', error);
        if (globalConnection) {
            try { await globalConnection.close(); } catch (e) { console.error('Worker: Error closing connection during error:', e); }
        }
    }
};

module.exports = {
    startWorker,
};
