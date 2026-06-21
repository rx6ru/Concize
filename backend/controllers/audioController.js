// controllers/audioController.js

const config = require('../configs/appConfig');
const { createLogger } = require('../utils/logger');
const { publishToQueue } = require('../services/amqp');
const { storeAudioFile, deleteAudioFile } = require('../db/cloudinary-utils/audio.db');

const logger = createLogger('audioController');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const audioQueue = config.queues.AUDIO_QUEUE;

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
    // New RESTful route resolves the meeting via req.meeting (ownership already verified);
    // legacy route falls back to the jobId cookie.
    const jobId = (req.meeting && req.meeting.meetingId) || req.cookies.jobId;
    const ownerId = (req.meeting && req.meeting.ownerId) || (req.user && req.user.id);

    // --- Input and Session Validation ---
    if (!audioFile) {
        logger.warn('No audio file provided');
        return res.status(400).send('No audio file provided.');
    }
    if (!jobId) {
        logger.warn('No meeting session found — missing jobId cookie');
        return res.status(400).send('No meeting session found. Please start a meeting first.');
    }

    logger.info('Audio file received', { jobId, size: audioFile.buffer.length });

    // --- Metadata Extraction ---
    let metadata;
    try {
        logger.debug('Extracting metadata with ffprobe', { jobId });
        metadata = await getMetadataFromBuffer(audioFile.buffer);

        let formatNames = [];
        if (metadata.format && metadata.format.format_name) {
            formatNames = metadata.format.format_name
                .split(',')
                .map(f => f.trim().toLowerCase());
        }

        logger.info('Metadata extraction succeeded', {
            jobId, formats: formatNames, duration: metadata.format.duration
        });

        metadata.format.formatNames = formatNames;
    } catch (err) {
        logger.error('Metadata parsing failed', { jobId, error: err.message });
        return res.status(500).send('Failed to process audio file metadata.');
    }

    // --- Validation Checks ---
    logger.debug('Running validation checks', { jobId });
    const validation = validateAudio(audioFile.buffer, metadata);
    if (!validation.valid) {
        logger.warn('Audio validation failed', { jobId, reason: validation.error });
        return res.status(400).send(validation.error);
    }
    logger.info('All validations passed', { jobId });

    // --- Upload to Cloudinary ---
    logger.info('Starting Cloudinary upload', { jobId });
    let fileId;
    try {
        const uploadResult = await storeAudioFile(audioFile.buffer, audioFile.originalname, jobId);
        fileId = uploadResult.public_id;
        logger.info('File uploaded to Cloudinary', { jobId, fileId });
    } catch (uploadErr) {
        logger.error('Cloudinary upload failed', { jobId, error: uploadErr.message });
        return res.status(500).send('Failed to upload audio file.');
    }

    // --- Publish to RabbitMQ (shared long-lived publisher connection) ---
    try {
        const isLastChunk = req.headers['x-last-chunk'] === 'true';
        const audioOffset = parseFloat(req.headers['x-audio-offset'] || '0');
        logger.debug('Chunk headers', { jobId, isLastChunk, audioOffset });

        const message = {
            jobId: jobId,
            ownerId: ownerId, // rides the queue so embeddings/summaries land owner-stamped
            fileId: fileId,
            isLastChunk: isLastChunk,
            metadata: {
                originalFileName: audioFile.originalname,
                mimetype: audioFile.mimetype,
                formatNames: metadata.format.formatNames,
                size: audioFile.buffer.length,
                duration: metadata.format.duration,
                uploadTimestamp: new Date().toISOString(),
                audioOffset: audioOffset,
            },
        };

        await publishToQueue(audioQueue, message);
        logger.info('Audio pushed to transcription queue', { jobId, fileId });

        res.status(202).json({
            message: 'Audio file received and pushed to queue for transcription.'
        });

    } catch (queueErr) {
        logger.error('RabbitMQ publish failed', { jobId, error: queueErr.message });

        if (fileId) {
            try {
                await deleteAudioFile(fileId);
                logger.info('Cleaned up uploaded file after queue failure', { jobId, fileId });
            } catch (cleanupErr) {
                logger.error('Failed to clean up file after queue failure', { jobId, fileId, error: cleanupErr.message });
            }
        }

        if (!res.headersSent) {
            res.status(500).send('Failed to push audio to queue.');
        }
    }
};

module.exports = { handleAudioUpload };
