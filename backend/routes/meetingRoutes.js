// routes/meetingRoutes.js
const express = require('express');
const router = express.Router();
const config = require('../utils/config');
const { createTranscription } = require('../db/mongoutils/transcription.db');
const crypto = require('crypto'); // Use Node.js built-in crypto module for UUID

// POST /api/meeting/start
// Initiates a new meeting session, generates a jobId, and sets it as a cookie.
router.post('/start', async (req, res) => {
    console.log('API Request: /api/meeting/start received.');
    try {
        const jobId = crypto.randomUUID(); // Generate a unique jobId

        // Create the initial transcription document in MongoDB with a 'pending' status
        const dbResult = await createTranscription(jobId);

        if (!dbResult) {
            console.error('API Error: Failed to create transcription document.');
            return res.status(500).json({ success: false, message: 'Failed to initialize transcription session in the database.' });
        }

        // Set the jobId as an HTTP-only cookie for security
        res.cookie('jobId', jobId, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });

        console.log(`New transcription session started with jobId: ${jobId}`);
        res.status(200).json({
            success: true,
            jobId: jobId,
            message: 'New meeting session initiated.'
        });

    } catch (error) {
        console.error('API Error in /api/meeting/start:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to start a new meeting.' });
    }
});



// The status route is no longer needed as the worker is now a persistent process
// Its status is not tied to a single meeting.

module.exports = router;
