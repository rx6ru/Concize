// controllers/meetingCompletion.js
const { updateMeetingStatus } = require('../db/mongoutils/transcription.db');

/**
 * Marks a meeting as completed in the database.
 * This function is intended to be called by the Worker when it processes
 * the final audio chunk of a session successfully.
 * 
 * @param {string} jobId - The unique identifier of the meeting/job.
 * @returns {Promise<boolean>} - True if successful, false otherwise.
 */
const completeMeeting = async (jobId) => {
    console.log(`COMPLETION_LOG: Attempting to mark meeting ${jobId} as completed...`);
    try {
        const result = await updateMeetingStatus(jobId, 'completed');
        if (result) {
            console.log(`COMPLETION_LOG: Successfully marked meeting ${jobId} as completed.`);
            return true;
        } else {
            console.warn(`COMPLETION_LOG: Failed to mark meeting ${jobId} as completed. Meeting might not exist.`);
            return false;
        }
    } catch (error) {
        console.error(`COMPLETION_ERROR: Error finalizing meeting ${jobId}:`, error);
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
    console.warn(`COMPLETION_WARN: Marking meeting ${jobId} as completed_with_errors...`);
    try {
        const result = await updateMeetingStatus(jobId, 'completed_with_errors');
        if (result) {
            console.warn(`COMPLETION_WARN: Meeting ${jobId} marked as completed_with_errors. Some data may be missing.`);
            return true;
        } else {
            console.error(`COMPLETION_ERROR: Failed to mark meeting ${jobId} as completed_with_errors.`);
            return false;
        }
    } catch (error) {
        console.error(`COMPLETION_ERROR: Error finalizing meeting ${jobId} with errors:`, error);
        return false;
    }
};

module.exports = { completeMeeting, completeMeetingWithErrors };
