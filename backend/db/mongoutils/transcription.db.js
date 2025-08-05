// transcription.db.js

const mongoose = require('mongoose');
const Meeting = require('../models/meeting.model'); // Import the Mongoose model
const config = require('../../utils/config'); // Import the config file

/**
 * Connects to the MongoDB database using the URI from the config.
 */
async function connectToMongo() {
    try {
        await mongoose.connect(config.MONGODB_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            dbName: 'concize' // Explicitly set the database name here
        });
        console.log('Connected to MongoDB via Mongoose.');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err);
        process.exit(1); // Exit process with failure
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
        console.log(`New transcription document created for jobId: ${jobId}`);
        return true;
    } catch (err) {
        console.error('Error creating transcription document:', err);
        return false;
    }
}

/**
 * Appends new text to an existing transcription document.
 * @param {string} jobId The unique identifier of the transcription job.
 * @param {string} newText The text chunk to append.
 * @returns {Promise<boolean>} True if the document was updated successfully.
 */
async function appendTranscription(jobId, newText) {
    try {
        const meeting = await Meeting.findOneAndUpdate(
            { jobId: jobId },
            { $push: { transcriptionChunks: newText } },
            { new: true } // Return the updated document
        );

        if (!meeting) {
            console.warn(`No document found for jobId: ${jobId}. Cannot append text.`);
            return false;
        }

        console.log(`Successfully appended text for jobId: ${jobId}`);
        return true;
    } catch (err) {
        console.error('Error appending transcription text:', err);
        return false;
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
        console.error('Error updating meeting status:', err);
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
        console.error('Error fetching meeting status:', err);
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
            console.log(`Found transcription document for jobId: ${jobId}`);
        } else {
            console.warn(`No transcription document found for jobId: ${jobId}`);
        }
        return document;
    } catch (err) {
        console.error('Error fetching transcription document:', err);
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
