// routes/meetingRoutes.js
const express = require('express');
const router = express.Router();
// Import the worker control functions from your worker.js file
const { startWorker, stopWorker, getWorkerStatus } = require('../controllers/worker');
const { createTranscription } = require('../db/mongoutil');
const crypto = require('crypto'); // Use Node.js built-in crypto module for UUID

// POST /api/meeting/start
// Initiates the RabbitMQ consumer worker, generates a new jobId, and sets it as a cookie.
router.post('/start', async (req, res) => {
    console.log('API Request: /api/meeting/start received.');
    try {
        const jobId = crypto.randomUUID(); // Generate a unique jobId

        // Create the initial transcription document in MongoDB
        const dbResult = await createTranscription(jobId);

        if (!dbResult) {
            console.error('API Error: Failed to create transcription document.');
            return res.status(500).json({ success: false, message: 'Failed to initialize transcription session in the database.' });
        }

        // Start the worker (assuming it's a singleton or manages its state)
        const workerResult = await startWorker(); // Call the function from worker.js

        if (workerResult.success) {
            // Set the jobId as an HTTP-only cookie for security
            res.cookie('jobId', jobId, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
            res.status(200).json({ ...workerResult, jobId: jobId, message: 'Worker started and new meeting session initiated.' });
        } else {
            res.status(500).json(workerResult);
        }
    } catch (error) {
        console.error('API Error in /api/meeting/start:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to start the worker.' });
    }
});

// POST /api/meeting/stop
// Stops the RabbitMQ consumer worker and gracefully closes connections.
router.post('/stop', async (req, res) => {
    console.log('API Request: /api/meeting/stop received.');
    try {
        const result = await stopWorker(); // Call the function from worker.js
        if (result.success) {
            // Clear the jobId cookie on session end
            res.clearCookie('jobId');
            res.status(200).json({ ...result, message: 'Worker stopped and meeting session ended.' });
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('API Error in /api/meeting/stop:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to stop the worker.' });
    }
});

// GET /api/meeting/status
// Retrieves the current operational status of the worker.
router.get('/status', (req, res) => {
    console.log('API Request: /api/meeting/status received.');
    try {
        const status = getWorkerStatus(); // Call the function from worker.js
        res.status(200).json(status);
    } catch (error) {
        console.error('API Error in /api/meeting/status:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to get worker status.' });
    }
});

module.exports = router;
