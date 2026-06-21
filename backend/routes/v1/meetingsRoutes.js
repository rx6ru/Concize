// routes/v1/meetingsRoutes.js
//
// Canonical RESTful, ownership-rooted resource tree:
//   POST /api/v1/meetings                       create a meeting (owner = caller)
//   POST /api/v1/meetings/:meetingId/audio      upload an audio chunk
//   GET  /api/v1/meetings/:meetingId/transcript fetch the transcript
//   POST /api/v1/meetings/:meetingId/chat       RAG chat (SSE)
//   GET  /api/v1/meetings/:meetingId/summary    fetch the running summary
//
// Auth travels in Authorization: Bearer; the resource id travels in the path.
// Every :meetingId route is gated by requireMeetingAccess (ownership → 404 on mismatch).

const express = require('express');
const multer = require('multer');
const router = express.Router();

const { requireMeetingAccess } = require('../../middlewares/auth');
const { startMeeting, fetchMeetingSummary } = require('../../controllers/meetingController');
const { handleAudioUpload } = require('../../controllers/audioController');
const { getLLMStreamResponse } = require('../../controllers/chatLLM');
const { getTranscription } = require('../../db/mongoutils/transcription.db');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('meetingsRoutes');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// Create a new meeting owned by the authenticated caller.
router.post('/', startMeeting);

// Upload an audio chunk to a meeting the caller owns.
router.post('/:meetingId/audio', requireMeetingAccess, upload.single('audio'), handleAudioUpload);

// Fetch the full transcript for an owned meeting.
router.get('/:meetingId/transcript', requireMeetingAccess, async (req, res) => {
    try {
        const document = await getTranscription(req.meeting.meetingId);
        if (!document) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }
        return res.status(200).json(document);
    } catch (error) {
        logger.error('Failed to fetch transcript', { meetingId: req.meeting.meetingId, error: error.message });
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// RAG chat over an owned meeting, streamed via SSE.
router.post('/:meetingId/chat', requireMeetingAccess, async (req, res) => {
    try {
        const { userPrompt } = req.body;
        if (!userPrompt) {
            return res.status(400).json({ error: 'userPrompt is required.' });
        }
        await getLLMStreamResponse(res, userPrompt, req.meeting.meetingId, req.meeting.ownerId);
    } catch (error) {
        logger.error('Chat stream error', { meetingId: req.meeting.meetingId, error: error.message });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
});

// Fetch the running summary for an owned meeting.
router.get('/:meetingId/summary', requireMeetingAccess, fetchMeetingSummary);

module.exports = router;
