// Deleting a meeting for real: the rows and the vectors.
//
// Postgres cascades everything derived from `meetings`, but the vectors live in Qdrant and no foreign key reaches them.
// Deleting only the rows leaves them behind forever: with the meeting gone, nothing records that they exist, so nothing can ever clean them up.
//
// Kept out of meeting.service because pipeline.wiring already requires that module, and reaching the vector index from there would close an import cycle.

'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('meetingPurge');

/**
 * @param {object} deps
 * @param {function} deps.purgeVectors      (meetingId) => Promise<void>
 * @param {function} deps.purgeChatVectors  (meetingId) => Promise<void>
 * @param {function} deps.deleteMeeting     (meetingId) => Promise<boolean>
 * @returns {function(string): Promise<{deleted: boolean}>}
 */
function createMeetingPurge({ purgeVectors, purgeChatVectors, deleteMeeting }) {
    return async function purge(meetingId) {
        // Vectors first, and the error is deliberately not swallowed: leaving the meeting intact makes this retryable, whereas dropping the row first would strand the vectors.
        await purgeVectors(meetingId);

        // A second collection, and the one a user would be most upset to find still there: every
        // chat turn embeds the question and the answer, and an answer quotes the transcript.
        await purgeChatVectors(meetingId);

        const deleted = await deleteMeeting(meetingId);
        logger.info('Meeting purged', { meetingId, deleted });
        return { deleted };
    };
}

module.exports = { createMeetingPurge };
