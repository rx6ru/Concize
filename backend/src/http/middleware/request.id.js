//
// Assigns each request a correlation id (honoring an inbound x-request-id if present), echoes it on
// the response, and runs the rest of the request inside an AsyncLocalStorage context so every log
// line downstream carries it. Mount this FIRST, before request logging / auth / routes.

const { randomUUID } = require('node:crypto');
const { als } = require('../../core/request.context');

function requestId(req, res, next) {
    const id = req.headers['x-request-id'] || randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    als.run({ requestId: id }, () => next());
}

module.exports = requestId;
