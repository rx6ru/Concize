// meeting.model.js
const mongoose = require('mongoose');
const config = require('../../configs/appConfig');

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
        enum: ['in-progress', 'completed', 'completed_with_errors'],
        default: 'in-progress',
        required: true
    },
});

// Create and export the Mongoose model with dynamic collection name
const collectionName = config.database.MONGO_COLLECTION || 'transcriptions';
// if (!collectionName) {
//     throw new Error('MONGO_COLLECTION must be defined in config');
// }
const Meeting = mongoose.model('Meeting', meetingSchema, collectionName);

module.exports = Meeting;
