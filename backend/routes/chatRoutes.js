// routes/chat.routes.js

const express = require('express');
const router = express.Router();
const { getLLMStreamResponse } = require('../controllers/chatLLM'); // Import the LLM streaming function

/**
 * @route POST /api/chat/stream
 * @desc Handles incoming chat messages and streams the AI's response.
 * @access Public (or add authentication middleware)
 */
router.post('/stream', async (req, res) => {
    try {
        const { userPrompt, jobId } = req.body;

        // Validate the incoming request data
        if (!userPrompt || !jobId) {
            return res.status(400).json({ error: 'userPrompt and jobId are required.' });
        }

        // Call the streaming function, which handles the entire RAG pipeline
        // The function manages the response streaming itself, so we don't need to send a response here.
        await getLLMStreamResponse(res, userPrompt, jobId);

    } catch (error) {
        console.error('Error in chat stream route:', error);
        // If an error occurs before streaming starts, send a standard JSON error response
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
});

module.exports = router;
