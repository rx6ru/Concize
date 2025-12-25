const mongoose = require('mongoose');

const meetingSummarySchema = new mongoose.Schema({
    jobId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    title: {
        type: String,
        default: ''
    },
    content: {
        type: String,
        default: ''
    },
    wordLimit: {
        type: Number,
        default: 500
    },
    lastProcessedChunkIndex: {
        type: Number,
        default: -1 // Indicates no chunks processed yet
    },
    version: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['pending', 'updating', 'complete', 'error'],
        default: 'pending'
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('MeetingSummary', meetingSummarySchema);
