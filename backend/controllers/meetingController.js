// controllers/meetingController.js

const crypto = require('crypto');
const { createLogger } = require('../utils/logger');
const { createTranscription } = require('../db/mongoutils/transcription.db');
const { getMeetingSummary } = require('../db/mongoutils/summary.db');

const logger = createLogger('meetingController');

/**
 * Initiates a new meeting session.
 * Generates a unique jobId, creates a transcription document in MongoDB,
 * and sets the jobId as an HTTP-only cookie.
 *
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 */
const startMeeting = async (req, res) => {
    logger.info('Meeting start requested');
    try {
        const jobId = crypto.randomUUID();

        const dbResult = await createTranscription(jobId);

        if (!dbResult) {
            logger.error('Failed to create transcription document', { jobId });
            return res.status(500).json({
                success: false,
                message: 'Failed to initialize transcription session in the database.'
            });
        }

        res.cookie('jobId', jobId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        });

        logger.info('Meeting session started', { jobId });
        res.status(200).json({
            success: true,
            jobId: jobId,
            message: 'New meeting session initiated.'
        });

    } catch (error) {
        logger.error('Failed to start meeting', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'An unexpected error occurred while trying to start a new meeting.'
        });
    }
};

/**
 * Retrieves the current summary state for a specific meeting.
 *
 * @param {Object} req - Express request (expects req.params.jobId).
 * @param {Object} res - Express response.
 */
const fetchMeetingSummary = async (req, res) => {
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
        logger.error('Failed to fetch meeting summary', { jobId: req.params.jobId, error: error.message });
        res.status(500).json({ success: false, error: "Failed to fetch meeting summary" });
    }
};

module.exports = { startMeeting, fetchMeetingSummary };
