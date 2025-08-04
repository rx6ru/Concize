// routes/meetingRoutes.js
const express = require('express');
const router = express.Router();
const amqp = require('amqplib'); // Import amqplib for RabbitMQ
const config = require('../utils/config'); // Import config to get the RabbitMQ URL
// Import the worker control functions from your worker.js file
const { startWorker, getWorkerStatus } = require('../controllers/worker');
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
// REVISED LOGIC: Sends a termination signal to the queue instead of stopping the worker directly.
router.post('/stop', async (req, res) => {
    console.log('API Request: /api/meeting/stop received.');
    const { jobId } = req.cookies;

    if (!jobId) {
        return res.status(400).send('No meeting session found to stop.');
    }

    let conn;
    let ch;

    try {
        const audioQueue = 'audio_queue';
        const CLOUDAMQP_URL = config.CLOUDAMQP_URL;
        conn = await amqp.connect(CLOUDAMQP_URL);
        ch = await conn.createConfirmChannel();
        await ch.assertQueue(audioQueue, { durable: true });

        // Create a special message to signal the worker to stop processing for this jobId
        const terminationMessage = {
            jobId: jobId,
            terminate: true,
        };

        console.log(`Sending termination signal for jobId ${jobId} to the queue.`);
        ch.sendToQueue(audioQueue, Buffer.from(JSON.stringify(terminationMessage)), { persistent: true });
        await ch.waitForConfirms(); // Wait for the queue to acknowledge the message

        // Respond with a 202 Accepted, as the worker will handle the termination asynchronously.
        res.status(202).json({ success: true, message: `Termination signal for jobId ${jobId} sent to queue. Worker will stop after processing all messages.` });
    } catch (error) {
        console.error('API Error in /api/meeting/stop:', error);
        res.status(500).json({ success: false, message: 'An unexpected error occurred while trying to send the termination signal.' });
    } finally {
        if (ch) await ch.close().catch(e => console.error("Error closing channel:", e));
        if (conn) await conn.close().catch(e => console.error("Error closing connection:", e));
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
