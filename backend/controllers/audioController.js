// controllers/audioController.js

const amqp = require('amqplib');
const config = require('../configs');
const { storeAudioFile, deleteAudioFile } = require('../db/cloudinary-utils/audio.db');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const audioQueue = config.AUDIO_QUEUE;
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

/**
 * Extracts audio metadata (format, duration) from a buffer using ffprobe.
 * @param {Buffer} buffer - The raw audio buffer.
 * @returns {Promise<Object>} ffprobe metadata object.
 */
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

/**
 * Validates the audio file against size and duration constraints.
 * @param {Buffer} buffer - The audio buffer.
 * @param {Object} metadata - The ffprobe metadata object.
 * @returns {{ valid: boolean, error?: string }} Validation result.
 */
function validateAudio(buffer, metadata) {
    if (buffer.length > 25 * 1024 * 1024) {
        return { valid: false, error: 'Audio file is too large (max 25MB).' };
    }

    if (!metadata || !metadata.format || !metadata.format.duration) {
        return { valid: false, error: 'Could not determine audio file duration.' };
    }

    if (metadata.format.duration > 15 * 60) {
        return { valid: false, error: 'Audio file is too long (max 15 minutes).' };
    }

    return { valid: true };
}

/**
 * Handles the full audio upload pipeline:
 *   1. Validate input & session
 *   2. Extract metadata (ffprobe)
 *   3. Validate size/duration
 *   4. Upload to Cloudinary
 *   5. Publish message to RabbitMQ
 *   6. Cleanup on failure
 *
 * @param {Object} req - Express request (expects req.file from multer, req.cookies.jobId).
 * @param {Object} res - Express response.
 */
const handleAudioUpload = async (req, res) => {
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

    // --- Metadata Extraction ---
    let metadata;
    try {
        console.log("3: Extracting metadata with ffprobe...");
        metadata = await getMetadataFromBuffer(audioFile.buffer);

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

        metadata.format.formatNames = formatNames;
    } catch (err) {
        console.error('An error occurred during metadata parsing:', err);
        return res.status(500).send('Failed to process audio file metadata.');
    }

    // --- Validation Checks ---
    console.log("5: Running validation checks...");
    const validation = validateAudio(audioFile.buffer, metadata);
    if (!validation.valid) {
        console.error(`Validation failed: ${validation.error}`);
        return res.status(400).send(validation.error);
    }
    console.log("10: All validations passed.");

    // --- Upload to Cloudinary ---
    console.log("11: Starting Cloudinary upload...");
    let fileId;
    try {
        const uploadResult = await storeAudioFile(audioFile.buffer, audioFile.originalname, jobId);
        fileId = uploadResult.public_id;
        console.log(`12: File uploaded to Cloudinary successfully with ID: ${fileId}`);
    } catch (uploadErr) {
        console.error('Failed to upload to Cloudinary:', uploadErr);
        return res.status(500).send('Failed to upload audio file.');
    }

    // --- Publish to RabbitMQ ---
    let conn;
    let ch;

    try {
        conn = await amqp.connect(CLOUDAMQP_URL);
        console.log("13: RabbitMQ connection established successfully!");
        ch = await conn.createConfirmChannel();
        console.log("14: Confirm channel created successfully!");

        await ch.assertQueue(audioQueue, { durable: true });

        const isLastChunk = req.headers['x-last-chunk'] === 'true';
        console.log(`14.5: Last chunk flag detected: ${isLastChunk}`);

        const message = {
            jobId: jobId,
            fileId: fileId,
            isLastChunk: isLastChunk,
            metadata: {
                originalFileName: audioFile.originalname,
                mimetype: audioFile.mimetype,
                formatNames: metadata.format.formatNames,
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
};

module.exports = { handleAudioUpload };
