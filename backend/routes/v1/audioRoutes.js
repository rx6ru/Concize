// routes/v1/audioRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { handleAudioUpload } = require('../../controllers/audioController');

// Configure Multer to store the file in memory as a Buffer.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

/**
 * @route POST /api/v1/audio
 * @desc Receives an audio chunk, validates it, uploads to Cloudinary,
 *       and pushes a transcription job to the message queue.
 * @access Protected (via tempAuthCheck middleware applied at mount level)
 */
router.post('/', upload.single('audio'), handleAudioUpload);

module.exports = router;