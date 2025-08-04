// meeting.model.js
const mongoose = require('mongoose');

// Define the schema for a meeting transcription
const meetingSchema = new mongoose.Schema({
    jobId: {
        type: String,
        required: true,
        unique: true, // Ensure each meeting has a unique job ID
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    transcriptionChunks: [
        {
            type: String,
        }
    ],
    // A new field to store the status of the meeting
    status: {
        type: String,
        enum: ['in-progress', 'completed'], // Restrict status to a set of valid values
        default: 'in-progress', // Set a default value for new meetings
        required: true
    },
});

// Create and export the Mongoose model
const Meeting = mongoose.model('Meeting', meetingSchema, 'transcriptions');

module.exports = Meeting;
