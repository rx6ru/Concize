// worker.js
const amqp = require('amqplib');
const { transcribe } = require('./transcription');
const fs = require('fs'); // Import Node.js file system module
const path = require('path'); // Import path module for file paths
const config = require('../utils/config'); // Import the centralized config

const audioQueue = 'audio_queue';
// Retrieve CloudAMQP URL from the centralized config
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

// Define a directory for transcriptions
const TRANSCRIPTION_DIR = './transcriptions';

// Ensure the transcription directory exists
if (!fs.existsSync(TRANSCRIPTION_DIR)) {
    fs.mkdirSync(TRANSCRIPTION_DIR, { recursive: true });
}

const startWorker = async () => {
    let conn;
    let ch;
    try {
        // Connect to RabbitMQ using the CloudAMQP URL from config
        conn = await amqp.connect(CLOUDAMQP_URL);
        ch = await conn.createChannel();

        await ch.assertQueue(audioQueue, { durable: true });
        console.log('Worker is running and waiting for audio transcription jobs...');

        // Set prefetch to limit the number of unacknowledged messages a consumer can process at once.
        // This prevents the worker from crashing if it receives too many large messages simultaneously.
        ch.prefetch(1); // Process one message at a time

        ch.consume(audioQueue, async (msg) => {
            if (msg !== null) {
                let messageContent;
                let audioBuffer;
                let metadata;

                try {
                    // Reconstruct the message content and Buffer
                    messageContent = JSON.parse(msg.content.toString());

                    // Check if messageContent.audioBufferData.data exists before creating Buffer
                    if (messageContent.audioBufferData && messageContent.audioBufferData.type === 'Buffer' && Array.isArray(messageContent.audioBufferData.data)) {
                        audioBuffer = Buffer.from(messageContent.audioBufferData.data);
                    } else {
                        throw new Error('Invalid audio buffer data received from queue.');
                    }

                    metadata = messageContent.metadata || {}; // Ensure metadata is an object

                    // Construct a filename for the transcription.
                    // For now, let's use a simple timestamp or original filename to identify sessions.
                    // In your future system, this would be tied to a session ID or user ID.
                    const transcriptionFileName = path.join(
                        TRANSCRIPTION_DIR,
                        `${metadata.uploadTimestamp ? metadata.uploadTimestamp.replace(/[:.]/g, '-') : 'transcription'}.txt`
                    );
                    
                    console.log(`Processing transcription for: ${metadata.originalname || 'unknown file'}`);

                    const result = await transcribe(audioBuffer, metadata);

                    if (result.success) {
                        const transcribedText = result.transcription;
                        console.log(`Transcription successful for "${metadata.originalname || 'unknown'}": ${transcribedText.substring(0, 50)}...`);

                        // Append the transcription to the designated file
                        // Add a newline for each chunk to keep them distinct
                        const textToAppend = `[${new Date().toISOString()}] (Chunk: ${metadata.originalname || 'N/A'}) \n${transcribedText}\n---\n`;
                        fs.appendFile(transcriptionFileName, textToAppend, (err) => {
                            if (err) {
                                console.error(`Error appending transcription to file ${transcriptionFileName}:`, err);
                            } else {
                                console.log(`Transcription appended to ${transcriptionFileName}`);
                            }
                        });

                    } else {
                        console.error(`Transcription failed for "${metadata.originalname || 'unknown'}":`, result.error);
                    }

                    ch.ack(msg); // Acknowledge the message
                    console.log(`Acknowledged message for "${metadata.originalname || 'unknown'}"`);

                } catch (error) {
                    console.error('Error processing message from queue:', error);
                    ch.nack(msg, false, true); // Requeue the message
                    console.error(`Nacked message for "${metadata.originalname || 'unknown'}" (requeued: true)`);
                }
            }
        }, {
            noAck: false // Crucial: Enable manual acknowledgments
        });
    } catch (error) {
        console.error('Worker initialization error:', error);
        if (conn) {
            try { await conn.close(); } catch (e) { console.error('Error closing connection:', e); }
        }
        process.exit(1);
    }
};

startWorker();