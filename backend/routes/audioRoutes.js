// audioRouter.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const amqp = require('amqplib');
const fs = require('fs');
const config = require('../utils/config'); // Corrected path to config

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

const upload = multer({
    dest: './uploads/',
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

router.post('/', upload.single('audio'), (req, res) => {
    const audioFile = req.file;

    if (!audioFile) {
        return res.status(400).send('No audio file provided.');
    }
    console.log("1: File received and Multer processed.");

    ffmpeg.ffprobe(audioFile.path, (err, metadata) => {
        console.log("2: ffprobe initiated.");
        if (err) {
            console.error('FFmpeg ffprobe error:', err);
            fs.unlink(audioFile.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });
            return res.status(400).send('Invalid or corrupt audio file.');
        }
        console.log("3: ffprobe succeeded. Metadata:", metadata.format.format_name, "Size:", metadata.format.size, "Duration:", metadata.format.duration);

        const supportedFormats = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'mp4', 'mpeg', 'mpga'];
        if (!metadata.format || !supportedFormats.includes(metadata.format.format_name)) {
            console.log("4: Unsupported format detected.");
            fs.unlink(audioFile.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });
            return res.status(400).send(`Unsupported audio format. Only ${supportedFormats.join(', ')} are supported.`);
        }
        console.log("5: Format check passed.");

        if (metadata.format.size > 100 * 1024 * 1024) {
            console.log("6: File size too large.");
            fs.unlink(audioFile.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });
            return res.status(400).send('Audio file is too large (max 100MB).');
        }
        console.log("7: Size check passed.");

        if (metadata.format.duration > 15 * 60) {
            console.log("8: File duration too long.");
            fs.unlink(audioFile.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });
            return res.status(400).send('Audio file is too long (max 15 minutes).');
        }
        console.log("9: Duration check passed. All validations complete.");








        fs.readFile(audioFile.path, async (readErr, audioBuffer) => {
            fs.unlink(audioFile.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });
            console.log("10: File read into buffer.");

            if (readErr) {
                console.error('Error reading audio file from disk:', readErr);
                return res.status(500).send('Failed to read audio file for processing.');
            }
            console.log("11: Buffer created. Attempting RabbitMQ connection...");

            let conn, ch;
            try {
                // Set connection timeout
                const connectPromise = amqp.connect(CLOUDAMQP_URL);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Connection timeout')), 10000);
                });
                
                conn = await Promise.race([connectPromise, timeoutPromise]);
                console.log("12: RabbitMQ connection established successfully!");

                ch = await conn.createChannel();
                console.log("13: Channel created.");

                await ch.assertQueue(audioQueue, { durable: true });

                const message = {
                    audioBufferData: audioBuffer,
                    metadata: {
                        originalname: audioFile.originalname,
                        mimetype: audioFile.mimetype,
                        formatName: metadata.format.format_name,
                        size: metadata.format.size,
                        duration: metadata.format.duration,
                        uploadTimestamp: new Date().toISOString(),
                    },
                };
                console.log("14: Message prepared and sending to queue.");

                await ch.sendToQueue(audioQueue, Buffer.from(JSON.stringify(message)), { persistent: true });
                console.log(`Audio chunk "${audioFile.originalname}" pushed to queue.`);
                res.status(202).send('Audio chunk received and pushed to queue for transcription.');

            } catch (error) {
                console.error('RabbitMQ error:', error.message);
                console.error('Full error:', error);
                res.status(500).send('Error with RabbitMQ: ' + error.message);
            } finally {
                try {
                    if (ch) await ch.close();
                    if (conn) await conn.close();
                } catch (closeErr) {
                    console.error('Error closing RabbitMQ connection:', closeErr);
                }
            }
        });






    });
});

module.exports = router;