// audioRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const amqp = require('amqplib');
const config = require('../utils/config');
// Updated import to use the new Cloudinary upload function.
const { storeAudioFile, deleteAudioFile } = require('../db/cloudinary-utils/audio.db');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

// Configure Multer to store the file in memory as a Buffer.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// --- Helper: Extract metadata with ffprobe ---
function getMetadataFromBuffer(buffer) {
    return new Promise((resolve, reject) => {
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);

        ffmpeg(stream).ffprobe((err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
}

router.post('/', upload.single('audio'), async (req, res) => {
    const audioFile = req.file;
    const { jobId } = req.cookies;

    // --- Input and Session Validation ---
    if (!audioFile) {
        console.error('Validation Error: No audio file provided.');
        return res.status(400).send('No audio file provided.');
    }
    if (!jobId) {
        console.error('Validation Error: No meeting session found.');
        return res.status(400).send('No meeting session found. Please start a meeting first.');
    }

    console.log(`1: File received for jobId ${jobId}.`);
    console.log(`2: File size: ${audioFile.buffer.length} bytes.`);

    let metadata;
    try {
        console.log("3: Extracting metadata with ffprobe...");
        metadata = await getMetadataFromBuffer(audioFile.buffer);

        // ✅ Handle multiple format names
        let formatNames = [];
        if (metadata.format && metadata.format.format_name) {
            formatNames = metadata.format.format_name
                .split(',')
                .map(f => f.trim().toLowerCase());
        }

        console.log(
            "4: Metadata extraction succeeded. Formats:",
            formatNames,
            "Duration:",
            metadata.format.duration
        );

        metadata.format.formatNames = formatNames; // store parsed formats
    } catch (err) {
        console.error('An error occurred during metadata parsing:', err);
        return res.status(500).send('Failed to process audio file metadata.');
    }

    // --- Validation Checks ---
    console.log("5: Running validation checks...");
    if (audioFile.buffer.length > 25 * 1024 * 1024) {
        console.error("6: File size too large.");
        return res.status(400).send('Audio file is too large (max 25MB).');
    }
    console.log("7: Size check passed.");

    if (!metadata || !metadata.format || !metadata.format.duration) {
        console.error("8: Failed to get duration from metadata.");
        return res.status(400).send('Could not determine audio file duration.');
    }

    if (metadata.format.duration > 15 * 60) {
        console.error("9: File duration too long.");
        return res.status(400).send('Audio file is too long (max 15 minutes).');
    }
    console.log("10: Duration check passed. All validations complete.");

    // --- Upload to Cloudinary and Push to Queue ---
    console.log("11: Validations passed. Starting Cloudinary upload...");
    
    let fileId;
    try {
        // Use the new function to upload to Cloudinary instead of Firebase.
        const uploadResult = await storeAudioFile(audioFile.buffer, audioFile.originalname, jobId);
        fileId = uploadResult.public_id;
        console.log(`12: File uploaded to Cloudinary successfully with ID: ${fileId}`);
    } catch (uploadErr) {
        console.error('Failed to upload to Cloudinary:', uploadErr);
        return res.status(500).send('Failed to upload audio file.');
    }

    let conn;
    let ch;

    try {
        conn = await amqp.connect(CLOUDAMQP_URL);
        console.log("13: RabbitMQ connection established successfully!");
        ch = await conn.createConfirmChannel();
        console.log("14: Confirm channel created successfully!");

        await ch.assertQueue(audioQueue, { durable: true });

        const message = {
            jobId: jobId,
            fileId: fileId, // Use the public_id directly
            metadata: {
                originalFileName: audioFile.originalname,
                mimetype: audioFile.mimetype,
                formatNames: metadata.format.formatNames, // ✅ use array of formats
                size: audioFile.buffer.length,
                duration: metadata.format.duration,
                uploadTimestamp: new Date().toISOString(),
            },
        };

        console.log("15: Message prepared and sending to queue.");

        ch.sendToQueue(audioQueue, Buffer.from(JSON.stringify(message)), { persistent: true });
        await ch.waitForConfirms();

        console.log(`Audio file with ID "${fileId}" for jobId ${jobId} confirmed by RabbitMQ and pushed to queue.`);

        res.status(202).json({
            message: 'Audio file received and pushed to queue for transcription.'
        });

    } catch (queueErr) {
        console.error('Error with RabbitMQ or message confirmation:', queueErr);
        
        // Clean up uploaded file if queue fails
        if (fileId) {
            try {
                const { deleteAudioFile } = require('../db/cloudinary-utils/audio.db');
                await deleteAudioFile(fileId);
                console.log('Cleaned up uploaded file due to queue failure');
            } catch (cleanupErr) {
                console.error('Failed to clean up file:', cleanupErr);
            }
        }
        
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
});

module.exports = router;