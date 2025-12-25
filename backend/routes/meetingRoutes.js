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

// Import getMeetingSummary
const { getMeetingSummary } = require('../db/mongoutils/summary.db');

// GET /api/meeting/:jobId/summary
// Retrieves the current summary state for a specific meeting job.
router.get('/:jobId/summary', async (req, res) => {
    try {
        const { jobId } = req.params;

        if (!jobId) {
            return res.status(400).json({ success: false, error: "Missing jobId parameter" });
        }

        const summary = await getMeetingSummary(jobId);

        if (!summary) {
            return res.status(404).json({ success: false, error: "Summary not found for this meeting" });
        }

        res.status(200).json({
            success: true,
            summary: {
                title: summary.title,
                content: summary.content,
                status: summary.status,
                updatedAt: summary.updatedAt
            }
        });

    } catch (error) {
        console.error(`API Error in /api/meeting/${req.params.jobId}/summary:`, error);
        res.status(500).json({ success: false, error: "Failed to fetch meeting summary" });
    }
});

module.exports = router;
