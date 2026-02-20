// routes/v1/meetingRoutes.js
const express = require('express');
const router = express.Router();
const { startMeeting, fetchMeetingSummary } = require('../../controllers/meetingController');

/**
 * @route POST /api/v1/meeting/start
 * @desc Initiates a new meeting session, generates a jobId, and sets it as a cookie.
 */
router.post('/start', startMeeting);

/**
 * @route GET /api/v1/meeting/:jobId/summary
 * @desc Retrieves the current summary state for a specific meeting job.
 */
router.get('/:jobId/summary', fetchMeetingSummary);

module.exports = router;
