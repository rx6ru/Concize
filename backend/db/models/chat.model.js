// chat.model.js
const mongoose = require('mongoose');

// Define the schema for a single chat conversation pair
const chatSchema = new mongoose.Schema({
    jobId: {
        type: String,
        required: true,
        // We won't make this unique because multiple chat pairs can exist for one jobId
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    userChat: {
        type: String,
        required: true,
    },
    aiChat: {
        type: String,
        required: false, // The AI response is added later during the streaming process
    },
});

// Create and export the Mongoose model
// The collection name 'chats' is explicitly specified to avoid Mongoose pluralizing it.
const Chat = mongoose.model('Chat', chatSchema, 'chats');

module.exports = Chat;
