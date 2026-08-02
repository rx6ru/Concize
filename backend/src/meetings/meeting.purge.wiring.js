// Composition root for meeting deletion: the Qdrant index plus the Postgres rows.

'use strict';

const { getQdrant } = require('../infra/qdrant');
const { getEmbeddingWithRetry } = require('../providers/embedding/embedding.service');
const { createChunkSearch } = require('../chat/chunk.search');
const { createMeetingPurge } = require('./meeting.purge');
const { deleteMeeting } = require('./meeting.repository');

let purge = null;

/** Built on first use so importing this module does not open a Qdrant connection. */
function purgeMeeting(meetingId) {
    if (!purge) {
        // embed is unused for a delete-by-filter, but the adapter is one object.
        const index = createChunkSearch({ client: getQdrant(), embed: getEmbeddingWithRetry });
        purge = createMeetingPurge({ purgeVectors: index.purgeMeeting, deleteMeeting });
    }
    return purge(meetingId);
}

/** Test seam. */
function _resetForTests() { purge = null; }

module.exports = { purgeMeeting, _resetForTests };
