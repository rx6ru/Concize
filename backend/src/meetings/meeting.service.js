const { updateMeetingStatus } = require('./meeting.repository');
const { createLogger } = require('../core/logger');

const logger = createLogger('meetingService');

/**
 * Marks a meeting as completed in the database.
 * This function is intended to be called by the Worker when it processes
 * the final audio chunk of a session successfully.
 * 
 * @param {string} jobId - The unique identifier of the meeting/job.
 * @returns {Promise<boolean>} - True if successful, false otherwise.
 */
const completeMeeting = async (jobId) => {
    logger.info(`Attempting to mark meeting as completed`, { jobId });
    try {
        const result = await updateMeetingStatus(jobId, 'completed');
        if (result) {
            logger.info(`Successfully marked meeting as completed`, { jobId });
            return true;
        } else {
            logger.warn(`Failed to mark meeting as completed - might not exist`, { jobId });
            return false;
        }
    } catch (error) {
        logger.error(`Error finalizing meeting`, { jobId, error: error.message });
        return false;
    }
};

/**
 * Marks a meeting as completed with errors in the database.
 * Called when the last chunk was received but processing failed (transcription/embedding).
 * The meeting is finalized but flagged to indicate incomplete data.
 * 
 * @param {string} jobId - The unique identifier of the meeting/job.
 * @returns {Promise<boolean>} - True if successful, false otherwise.
 */
const completeMeetingWithErrors = async (jobId) => {
    logger.warn(`Marking meeting as completed_with_errors`, { jobId });
    try {
        const result = await updateMeetingStatus(jobId, 'completed_with_errors');
        if (result) {
            logger.warn(`Meeting marked as completed_with_errors. Some data may be missing.`, { jobId });
            return true;
        } else {
            logger.error(`Failed to mark meeting as completed_with_errors`, { jobId });
            return false;
        }
    } catch (error) {
        logger.error(`Error finalizing meeting with errors`, { jobId, error: error.message });
        return false;
    }
};

module.exports = { completeMeeting, completeMeetingWithErrors };
