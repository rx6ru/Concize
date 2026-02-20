const MeetingSummary = require('../models/meetingSummary.model');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('summaryDb');

/**
 * Retrieves the meeting summary for a given job ID.
 * @param {string} jobId - The unique identifier for the meeting.
 * @returns {Promise<Object|null>} The meeting summary document (lean) or null if not found.
 */
const getMeetingSummary = async (jobId) => {
    try {
        return await MeetingSummary.findOne({ jobId }).lean();
    } catch (error) {
        logger.error(`Failed to fetch summary`, { jobId, error: error.message });
        throw error;
    }
};

/**
 * Updates the meeting summary incrementally.
 * Enforces strict sequential processing using lastProcessedChunkIndex.
 * 
 * @param {string} jobId - The unique identifier for the meeting.
 * @param {number} chunkIndex - The index of the chunk being processed.
 * @returns {Promise<Object>} The updated (but not yet saved with content) summary document.
 * @throws {Error} If the chunk is out of order.
 */
const startSummaryUpdate = async (jobId, chunkIndex) => {
    try {
        // Atomic check-and-update to reserve this chunk processing
        // Only matches if lastProcessedChunkIndex is exactly chunkIndex - 1
        const query = {
            jobId,
            lastProcessedChunkIndex: chunkIndex - 1
        };

        const update = {
            $set: { status: 'updating' },
            $inc: { version: 1 },
            // If it's the first chunk (0), we might need to set creation fields if upserting
            $setOnInsert: {
                createdAt: new Date(),
                title: 'New Meeting'
            }
        };

        // Special case for first chunk: upsert = true
        // For subsequent chunks, document must exist
        const options = {
            new: true,
            upsert: chunkIndex === 0
        };

        const summary = await MeetingSummary.findOneAndUpdate(query, update, options);

        if (!summary) {
            // Check if it's an out-of-order issue or just missing doc
            const existing = await MeetingSummary.findOne({ jobId });
            if (existing) {
                logger.warn(`Skipped chunk: out of order`, { jobId, chunkIndex, expected: existing.lastProcessedChunkIndex + 1 });
                throw new Error(`Out of order: chunk ${chunkIndex}, expected ${existing.lastProcessedChunkIndex + 1}`);
            } else if (chunkIndex > 0) {
                logger.warn(`Skipped chunk: missing doc`, { jobId, chunkIndex });
                throw new Error(`Summary document indicates missing start for chunk ${chunkIndex}`);
            }
        }

        return summary;
    } catch (error) {
        logger.error(`Failed to start summary update`, { jobId, chunkIndex, error: error.message });
        throw error;
    }
};

/**
 * Finalizes the summary content after LLM generation.
 * @param {string} jobId 
 * @param {Object} updatedData - { title, content }
 * @param {number} chunkIndex 
 */
const saveSummaryContent = async (jobId, updatedData, chunkIndex) => {
    try {
        await MeetingSummary.updateOne(
            { jobId },
            {
                $set: {
                    title: updatedData.title,
                    content: updatedData.summary, // Map 'summary' property to 'content' field
                    lastProcessedChunkIndex: chunkIndex,
                    status: 'updating', // Keeps it usable, 'complete' is for end of meeting
                    updatedAt: new Date()
                }
            }
        );
        logger.info(`Summary chunk saved`, { jobId, chunkIndex });
    } catch (error) {
        logger.error(`Failed to save summary content`, { jobId, error: error.message });
        throw error;
    }
};

/**
 * Marks the summary as fully complete (end of meeting).
 */
const completeSummary = async (jobId) => {
    try {
        await MeetingSummary.updateOne(
            { jobId },
            { $set: { status: 'complete', updatedAt: new Date() } }
        );
        logger.info(`Summary finalized`, { jobId });
    } catch (error) {
        logger.error(`Failed to complete summary`, { jobId, error: error.message });
        throw error;
    }
};

module.exports = {
    getMeetingSummary,
    startSummaryUpdate,
    saveSummaryContent,
    completeSummary
};
