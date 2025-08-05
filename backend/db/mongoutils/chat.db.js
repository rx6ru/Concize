// db/mongoutils/chat.db.js

const mongoose = require('mongoose');
const Chat = require('../models/chat.model'); // Corrected path to the Chat model

/**
 * Creates a new chat entry in the chats collection.
 * This is typically called when a user sends a new message.
 * The AI response will be added in a subsequent update.
 *
 * @param {string} jobId - The unique ID of the meeting session.
 * @param {string} userChat - The message sent by the user.
 * @returns {Promise<Object>} The newly created chat document.
 */
const createChatEntry = async (jobId, userChat) => {
    try {
        const newChat = new Chat({
            jobId,
            userChat,
            // aiChat is intentionally left blank for now
        });
        const savedChat = await newChat.save();
        console.log(`Chat entry created for jobId: ${jobId}, chatId: ${savedChat._id}`);
        return savedChat;
    } catch (error) {
        console.error('Error creating chat entry:', error);
        throw error;
    }
};

/**
 * Updates an existing chat entry with the AI's response.
 * This is called after the LLM has generated a complete response.
 *
 * @param {string} chatId - The unique ID of the chat document to update.
 * @param {string} aiChat - The complete response from the AI.
 * @returns {Promise<Object>} The updated chat document.
 */
const updateChatEntry = async (chatId, aiChat) => {
    try {
        const updatedChat = await Chat.findByIdAndUpdate(
            chatId,
            { $set: { aiChat: aiChat } },
            { new: true, runValidators: true } // Return the updated document and run schema validators
        );
        if (!updatedChat) {
            throw new Error('Chat document not found for update.');
        }
        console.log(`Chat entry updated with AI response for chatId: ${chatId}`);
        return updatedChat;
    } catch (error) {
        console.error('Error updating chat entry:', error);
        throw error;
    }
};

/**
 * Retrieves the chat history for a given meeting session, sorted by timestamp.
 *
 * @param {string} jobId - The unique ID of the meeting session.
 * @param {number} [limit=5] - The number of recent chat pairs to retrieve.
 * @returns {Promise<Array>} An array of chat documents.
 */
const getChatHistory = async (jobId, limit = 5, beforeChatId = null) => {
    try {
        // Start with a base query to find all chats for the specific jobId.
        const query = { jobId };

        // If a beforeChatId is provided, add a condition to the query
        // to find chats with an _id less than the provided one.
        // MongoDB ObjectIds are chronologically ordered, so this finds older chats.
        if (beforeChatId) {
            query._id = { $lt: beforeChatId };
        }

        // Build the Mongoose query chain.
        const chatHistory = await Chat.find(query)
            .sort({ createdAt: -1 }) // Sort by creation date descending to get the newest first.
            .limit(limit)           // Limit to the most recent chats based on the sort.
            .exec();

        // Reverse the order to display them in chronological order for the user.
        return chatHistory.reverse();
    } catch (error) {
        console.error('Error retrieving chat history:', error);
        // It's good practice to re-throw the error so the calling function can handle it.
        throw error;
    }
};


module.exports = {
    createChatEntry,
    updateChatEntry,
    getChatHistory,
};
