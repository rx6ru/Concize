// audioRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer'); // Multer for handling multipart/form-data
const ffmpeg = require('fluent-ffmpeg'); // For audio metadata (ffprobe)
const amqp = require('amqplib'); // For RabbitMQ
const fs = require('fs'); // Still needed for ffprobe, but not for reading the main audio buffer
const path = require('path');
const config = require('../utils/config'); // Import the centralized config

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

// Configure Multer to save files to disk
const upload = multer({
    dest: 'uploads/', // <-- KEY CHANGE: Multer now saves files to the 'uploads' directory
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

router.post('/', upload.single('audio'), async (req, res) => {
    const audioFile = req.file;
    const { jobId } = req.cookies; // Get jobId from the cookies

    // --- Input and Session Validation ---
    if (!audioFile) {
        return res.status(400).send('No audio file provided.');
    }
    if (!jobId) {
        // If there's no jobId, the meeting session hasn't been initiated.
        return res.status(400).send('No meeting session found. Please start a meeting first.');
    }

    console.log(`1: File received for jobId ${jobId}.`);

    // Multer with dest provides the file path
    const filePath = path.join(__dirname, '..', audioFile.path);

    try {
        console.log("2: ffprobe initiated.");
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, meta) => {
                if (err) reject(err);
                resolve(meta);
            });
        });

        console.log("3: ffprobe succeeded. Metadata:", metadata.format.format_name, "Size:", metadata.format.size, "Duration:", metadata.format.duration);

        // Check format
        const supportedFormats = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'mpeg', 'mpga'];
        if (!metadata.format || !supportedFormats.includes(metadata.format.format_name)) {
            console.log("4: Unsupported format detected.");
            fs.unlink(filePath, (unlinkErr) => { if (unlinkErr) console.error('Error deleting file:', unlinkErr); });
            return res.status(400).send(`Unsupported audio format. Only ${supportedFormats.join(', ')} are supported.`);
        }
        console.log("5: Format check passed.");

        // Check size
        if (metadata.format.size > 25 * 1024 * 1024) {
            console.log("6: File size too large.");
            fs.unlink(filePath, (unlinkErr) => { if (unlinkErr) console.error('Error deleting file:', unlinkErr); });
            return res.status(400).send('Audio file is too large (max 25MB).');
        }
        console.log("7: Size check passed.");

        // Check duration
        if (metadata.format.duration > 15 * 60) {
            console.log("8: File duration too long.");
            fs.unlink(filePath, (unlinkErr) => { if (unlinkErr) console.error('Error deleting file:', unlinkErr); });
            return res.status(400).send('Audio file is too long (max 15 minutes).');
        }
        console.log("9: Duration check passed. All validations complete.");

        // --- Push to queue ---
        console.log("10: Preparing message with file path and jobId. Attempting RabbitMQ connection...");

        let conn;
        let ch;

        try {
            conn = await amqp.connect(CLOUDAMQP_URL);
            console.log("11: RabbitMQ connection established successfully!");

            ch = await conn.createConfirmChannel();
            console.log("12: Confirm channel created successfully!");

            await ch.assertQueue(audioQueue, { durable: true });

            const message = {
                // KEY CHANGE: Now including the jobId
                jobId: jobId,
                filePath: filePath,
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

            ch.sendToQueue(audioQueue, Buffer.from(JSON.stringify(message)), { persistent: true });

            await ch.waitForConfirms();

            console.log(`Audio file path "${audioFile.originalname}" for jobId ${jobId} confirmed by RabbitMQ and pushed to queue.`);

            res.status(202).send('Audio file received and pushed to queue for transcription.');

        } catch (queueErr) {
            console.error('Error with RabbitMQ or message confirmation:', queueErr);
            if (!res.headersSent) {
                res.status(500).send('Failed to push audio to queue.');
            }
        } finally {
            if (ch) {
                await ch.close().catch(e => console.error("Error closing channel:", e));
            }
            if (conn) {
                await conn.close().catch(e => console.error("Error closing connection:", e));
            }
        }
    } catch (err) {
        console.error('An error occurred during audio processing or validation:', err);
        // Clean up the file on disk if an error occurred
        fs.unlink(filePath, (unlinkErr) => { if (unlinkErr) console.error('Error deleting file:', unlinkErr); });
        return res.status(500).send('Failed to process audio file.');
    }
});

module.exports = router;
