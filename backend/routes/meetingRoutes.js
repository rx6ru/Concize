// routes/meetingRoutes.js
const express = require('express');
const router = express.Router();
// Import the worker control functions from your worker.js file
const { startWorker, stopWorker, getWorkerStatus } = require('../controllers/worker'); 

// POST /api/worker/start
// Initiates the RabbitMQ consumer worker.
router.post('/start', async (req, res) => {
    console.log('API Request: /api/worker/start received.');
    try {
        const result = await startWorker(); // Call the function from worker.js
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('API Error in /api/worker/start:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to start the worker.' });
    }
});

// POST /api/worker/stop
// Stops the RabbitMQ consumer worker and gracefully closes connections.
router.post('/stop', async (req, res) => {
    console.log('API Request: /api/worker/stop received.');
    try {
        const result = await stopWorker(); // Call the function from worker.js
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('API Error in /api/worker/stop:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to stop the worker.' });
    }
});

// GET /api/worker/status
// Retrieves the current operational status of the worker.
router.get('/status', (req, res) => {
    console.log('API Request: /api/worker/status received.');
    try {
        const status = getWorkerStatus(); // Call the function from worker.js
        res.status(200).json(status);
    } catch (error) {
        console.error('API Error in /api/worker/status:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to get worker status.' });
    }
});

module.exports = router;