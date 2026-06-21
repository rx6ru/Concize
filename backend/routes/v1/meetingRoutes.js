// routes/v1/meetingRoutes.js
const express = require('express');
const router = express.Router();
const { startMeeting, fetchMeetingSummary } = require('../../controllers/meetingController');
const { requireLegacyMeetingAccess } = require('../../middlewares/auth');

/**
 * @route POST /api/v1/meeting/start
 * @desc Initiates a new meeting session, generates a jobId, and sets it as a cookie.
 */
router.post('/start', startMeeting);

/**
 * @route GET /api/v1/meeting/:jobId/summary
 * @desc Retrieves the current summary state (legacy; ownership enforced).
 */
router.get('/:jobId/summary', requireLegacyMeetingAccess, fetchMeetingSummary);

module.exports = router;
