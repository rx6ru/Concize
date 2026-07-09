// Shared Qdrant client.
//
// Built once and lazily. The REST client holds a keep-alive agent, so building a new one per
// query throws that away, and lazy construction means this module can be required by tests
// that don't have a real vector database to connect to.

'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../core/config');

let client = null;

function getQdrant() {
    if (!client) {
        client = new QdrantClient({
            url: config.database.QDRANT_URL,
            apiKey: config.database.QDRANT_API_KEY,
            timeout: 60000,
            checkCompatibility: false,   // skip the version-check round-trip on construction
        });
    }
    return client;
}

/** Test seam. */
function _resetForTests() {
    client = null;
}

module.exports = { getQdrant, _resetForTests };
