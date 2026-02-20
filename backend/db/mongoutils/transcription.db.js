// transcription.db.js

const mongoose = require('mongoose');
const Meeting = require('../models/meeting.model'); // Import the Mongoose model
const config = require('../../configs/appConfig');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('transcriptionDb');

/**
 * Connects to the MongoDB database using the URI from the config.
 */
async function connectToMongo() {
    try {
        await mongoose.connect(config.database.MONGODB_URL, {
            dbName: 'concize' // Explicitly set the database name here
        });
        logger.info('Connected to MongoDB via Mongoose');
    } catch (err) {
        logger.error('Error connecting to MongoDB', { error: err.message });
        throw err; // Allow caller to handle shutdown
    }
}

/**
 * Creates a new transcription document in the database.
 * @param {string} jobId A unique identifier for the transcription job.
 * @returns {Promise<boolean>} True if the document was created successfully.
 */
async function createTranscription(jobId) {
    try {
        const newMeeting = new Meeting({
            jobId: jobId,
        });
        await newMeeting.save();
        logger.info(`New transcription document created`, { jobId });
        return true;
    } catch (err) {
        logger.error('Error creating transcription document', { jobId, error: err.message });
        return false;
    }
}

/**
 * Appends new text to an existing transcription document.
 * If the document does not exist, it creates a new one and appends the text.
 * @param {string} jobId The unique identifier of the transcription job.
 * @param {string} newText The text chunk to append.
 * @returns {Promise<Object>} Object containing success status and chunkIndex.
 */
async function appendTranscription(jobId, newText) {
    try {
        const result = await Meeting.findOneAndUpdate(
            { jobId: jobId },
            { $push: { transcriptionChunks: newText } },
            { new: true, upsert: true } // Return the updated document, create if not found
        );

        if (result) {
            const chunkIndex = result.transcriptionChunks.length - 1;
            logger.info(`Successfully appended text`, { jobId, chunkIndex });
            return { success: true, chunkIndex };
        }

        logger.warn(`Failed to append text - unknown error`, { jobId });
        return { success: false, chunkIndex: -1 };
    } catch (err) {
        logger.error('Error appending transcription text', { jobId, error: err.message });
        return { success: false, chunkIndex: -1, error: err };
    }
}

/**
 * Updates the status of a meeting document.
 * @param {string} jobId The unique identifier of the transcription job.
 * @param {string} newStatus The new status to set (e.g., 'completed').
 * @returns {Promise<boolean>} True if the document was updated successfully.
 */
async function updateMeetingStatus(jobId, newStatus) {
    try {
        const result = await Meeting.findOneAndUpdate(
            { jobId: jobId },
            { status: newStatus },
            { new: true }
        );
        return !!result; // Return true if a document was found and updated
    } catch (err) {
        logger.error('Error updating meeting status', { jobId, newStatus, error: err.message });
        return false;
    }
}

/**
 * Fetches the status of a meeting document.
 * @param {string} jobId The unique identifier of the transcription job.
 * @returns {Promise<string|null>} The status string or null if the document is not found.
 */
async function getMeetingStatus(jobId) {
    try {
        const meeting = await Meeting.findOne({ jobId: jobId }, { status: 1, _id: 0 });
        return meeting ? meeting.status : null;
    } catch (err) {
        logger.error('Error fetching meeting status', { jobId, error: err.message });
        return null;
    }
}

/**
 * Fetches the full transcription document for a given job ID.
 * @param {string} jobId The unique identifier of the transcription job.
 * @returns {Promise<object|null>} The transcription document or null if not found.
 */
async function getTranscription(jobId) {
    try {
        const document = await Meeting.findOne({ jobId: jobId }, { _id: 0, jobId: 0, __v: 0 });
        if (document) {
            logger.debug(`Found transcription document`, { jobId });
        } else {
            logger.warn(`No transcription document found`, { jobId });
        }
        return document;
    } catch (err) {
        logger.error('Error fetching transcription document', { jobId, error: err.message });
        return null;
    }
}

module.exports = {
    connectToMongo,
    createTranscription,
    appendTranscription,
    getTranscription,
    updateMeetingStatus,
    getMeetingStatus,
};
