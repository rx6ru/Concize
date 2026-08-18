// Chat persistence on Supabase Postgres.

const crypto = require('crypto');
const { query } = require('../infra/postgres');
const { createLogger } = require('../core/logger');

const logger = createLogger('chatRepository');

/**
 * Maps a snake_case DB row to camelCase, adding an `_id` alias for backward-compat.
 * @param {Object} row
 */
function mapChat(row) {
    return {
        _id: row.id,
        id: row.id,
        jobId: row.job_id,
        userChat: row.user_chat,
        aiChat: row.ai_chat,
        createdAt: row.created_at,
    };
}

/**
 * Creates a new chat entry for a user message (ai_chat left null for now).
 *
 * @param {string} jobId  The meeting session id.
 * @param {string} userChat  The user's message.
 * @returns {Promise<Object>} The newly created chat, including `_id`.
 */
const createChatEntry = async (jobId, userChat) => {
    const id = crypto.randomUUID();
    try {
        const { rows } = await query(
            'INSERT INTO chats (id, job_id, user_chat) VALUES ($1, $2, $3) RETURNING *',
            [id, jobId, userChat]
        );
        const chat = mapChat(rows[0]);
        logger.info('Chat entry created', { jobId, chatId: chat._id });
        return chat;
    } catch (error) {
        logger.error('Error creating chat entry', { jobId, error: error.message });
        throw error;
    }
};

/**
 * Updates an existing chat entry with the AI response.
 *
 * @param {string} chatId  The chat row id.
 * @param {string} aiChat  The AI's response.
 * @returns {Promise<Object>} The updated chat row, mapped to camelCase.
 */
const updateChatEntry = async (chatId, aiChat) => {
    try {
        const { rows } = await query(
            'UPDATE chats SET ai_chat = $2 WHERE id = $1 RETURNING *',
            [chatId, aiChat]
        );
        if (!rows.length) {
            throw new Error('Chat document not found for update.');
        }
        const chat = mapChat(rows[0]);
        logger.info('Chat entry updated with AI response', { chatId });
        return chat;
    } catch (error) {
        logger.error('Error updating chat entry', { chatId, error: error.message });
        throw error;
    }
};

/**
 * Returns the most recent `limit` chats for a job in chronological (ascending) order.
 * Optionally restricts to chats created before `beforeChatId`.
 *
 * @param {string} jobId
 * @param {number} [limit=5]
 * @param {string|null} [beforeChatId=null]
 * @returns {Promise<Array>}
 */
const getChatHistory = async (jobId, limit = 5, beforeChatId = null) => {
    try {
        let text;
        let params;

        if (beforeChatId) {
            text = `
                SELECT * FROM chats
                WHERE job_id = $1
                  AND created_at < (SELECT created_at FROM chats WHERE id = $3)
                ORDER BY created_at DESC
                LIMIT $2
            `;
            params = [jobId, limit, beforeChatId];
        } else {
            text = `
                SELECT * FROM chats
                WHERE job_id = $1
                ORDER BY created_at DESC
                LIMIT $2
            `;
            params = [jobId, limit];
        }

        const { rows } = await query(text, params);
        // Reverse DESC results to return ascending (chronological) order.
        return rows.reverse().map(mapChat);
    } catch (error) {
        logger.error('Error retrieving chat history', { jobId, error: error.message });
        throw error;
    }
};

module.exports = {
    createChatEntry,
    updateChatEntry,
    getChatHistory,
};
