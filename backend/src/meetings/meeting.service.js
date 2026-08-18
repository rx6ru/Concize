const { updateMeetingStatus } = require('./meeting.repository');
const { createLogger } = require('../core/logger');

const logger = createLogger('meetingService');

/** Marks a meeting as completed. Called by the Worker after the final audio chunk of a session processes successfully. */
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

/** Marks a meeting as completed_with_errors: the last chunk arrived but transcription/embedding failed, so the meeting is finalized but flagged as incomplete. */
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
