// routes/chat.routes.js

const express = require('express');
const router = express.Router();
const { getLLMStreamResponse } = require('../../controllers/chatLLM'); // Import the LLM streaming function
const { requireLegacyMeetingAccess } = require('../../middlewares/auth');

/**
 * @route POST /api/v1/chat/stream
 * @desc Handles incoming chat messages and streams the AI's response.
 * @access Legacy compat shim; ownership enforced via requireLegacyMeetingAccess (body jobId).
 */
router.post('/stream', requireLegacyMeetingAccess, async (req, res) => {
    try {
        const { userPrompt } = req.body;

        if (!userPrompt) {
            return res.status(400).json({ error: 'userPrompt is required.' });
        }

        // Ownership already verified; use the gated meeting + owner.
        await getLLMStreamResponse(res, userPrompt, req.meeting.meetingId, req.meeting.ownerId);

    } catch (error) {
        console.error('Error in chat stream route:', error);
        // If an error occurs before streaming starts, send a standard JSON error response
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
});

module.exports = router;
