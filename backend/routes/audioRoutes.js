// audioRouter.js
const express = require('express');
const router = express.Router();
const multer = require('multer'); // Multer for handling multipart/form-data
const ffmpeg = require('fluent-ffmpeg'); // For audio metadata (ffprobe)
const amqp = require('amqplib'); // For RabbitMQ
const fs = require('fs'); // Still needed for ffprobe, but not for reading the main audio buffer
const config = require('../utils/config'); // Import the centralized config

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

// Configure Multer to store files directly in memory as a Buffer
const upload = multer({
    storage: multer.memoryStorage(), // <--- KEY CHANGE: Store in memory
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

router.post('/', upload.single('audio'), (req, res) => {
    const audioFile = req.file;

    // --- Input Validation ---
    if (!audioFile) {
        return res.status(400).send('No audio file provided.');
    }
    console.log("1: File received and Multer processed (in memory).");

    // Multer with memoryStorage provides the buffer directly in req.file.buffer
    // For ffprobe, we need to save the buffer to a temporary file first,
    // as ffprobe typically works with file paths, not directly with buffers.
    // This is a temporary disk write for ffprobe, which will be deleted immediately.
    const tempFilePath = `./uploads/${audioFile.filename || Date.now() + '-' + Math.random().toString(36).substring(7) + '.tmp'}`;
    
    // Ensure the uploads directory exists for temp files
    if (!fs.existsSync('./uploads')) {
        fs.mkdirSync('./uploads', { recursive: true });
    }

    fs.writeFile(tempFilePath, audioFile.buffer, (writeErr) => {
        if (writeErr) {
            console.error('Error writing temporary file for ffprobe:', writeErr);
            return res.status(500).send('Failed to process audio file.');
        }

        // ffprobe needs the actual file path
        ffmpeg.ffprobe(tempFilePath, (err, metadata) => {
            // Clean up the temporary file immediately after ffprobe
            fs.unlink(tempFilePath, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });

            console.log("2: ffprobe initiated.");
            if (err) {
                console.error('FFmpeg ffprobe error:', err);
                return res.status(400).send('Invalid or corrupt audio file.');
            }
            console.log("3: ffprobe succeeded. Metadata:", metadata.format.format_name, "Size:", metadata.format.size, "Duration:", metadata.format.duration);

            // Check format
            const supportedFormats = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'mp4', 'mpeg', 'mpga']; // Common audio formats Groq supports
            if (!metadata.format || !supportedFormats.includes(metadata.format.format_name)) {
                console.log("4: Unsupported format detected.");
                return res.status(400).send(`Unsupported audio format. Only ${supportedFormats.join(', ')} are supported.`);
            }
            console.log("5: Format check passed.");

            // Check size (Multer already handles this, but an extra check from ffprobe metadata is fine)
            if (metadata.format.size > 100 * 1024 * 1024) { // 100MB
                console.log("6: File size too large.");
                return res.status(400).send('Audio file is too large (max 100MB).');
            }
            console.log("7: Size check passed.");

            // Check duration (Groq API has limits, often around 25MB or 10 minutes depending on tier/model)
            // Adjust this limit based on the Groq Whisper model's actual max duration if known.
            // 15 minutes = 900 seconds
            if (metadata.format.duration > 15 * 60) {
                console.log("8: File duration too long.");
                return res.status(400).send('Audio file is too long (max 15 minutes).');
            }
            console.log("9: Duration check passed. All validations complete.");

            // --- Push to queue ---
            // The audioBuffer is already available from req.file.buffer
            const audioBufferToQueue = audioFile.buffer;
            console.log("10: Audio buffer ready for queueing. Attempting RabbitMQ connection...");

            // Connect to RabbitMQ using the CloudAMQP URL from config
            amqp.connect(CLOUDAMQP_URL, (amqpErr, conn) => {
                if (amqpErr) {
                    console.error('RabbitMQ connection error:');
                    console.error('  Message:', amqpErr.message);
                    console.error('  Code:', amqpErr.code || 'N/A');
                    console.error('  Stack:', amqpErr.stack);
                    return res.status(500).send('Error connecting to RabbitMQ.');
                }
                console.log("11: RabbitMQ connection established successfully!");

                conn.createChannel((channelErr, ch) => {
                    if (channelErr) {
                        console.error('RabbitMQ channel error:', channelErr);
                        if (conn && conn.close) conn.close(); // Ensure connection is closed
                        return res.status(500).send('Error creating RabbitMQ channel.');
                    }
                    console.log("12: Channel created.");

                    ch.assertQueue(audioQueue, { durable: true });

                    const message = {
                        audioBufferData: audioBufferToQueue, // The actual audio buffer
                        metadata: {
                            originalname: audioFile.originalname,
                            mimetype: audioFile.mimetype,
                            formatName: metadata.format.format_name,
                            size: metadata.format.size,
                            duration: metadata.format.duration,
                            uploadTimestamp: new Date().toISOString(),
                        },
                    };
                    console.log("13: Message prepared and sending to queue.");

                    try {
                        ch.sendToQueue(audioQueue, Buffer.from(JSON.stringify(message)), { persistent: true });
                        console.log(`Audio chunk "${audioFile.originalname}" pushed to queue.`);
                        res.status(202).send('Audio chunk received and pushed to queue for transcription.');
                    } catch (queueSendErr) {
                        console.error('Error sending message to RabbitMQ queue:', queueSendErr);
                        res.status(500).send('Failed to push audio to queue.');
                    } finally {
                        setTimeout(() => {
                            if (ch && ch.close) ch.close();
                            if (conn && conn.close) conn.close();
                        }, 500);
                    }
                });
            });
        });
    });
});

module.exports = router;