// V1 API route aggregator.

const router = require('express').Router();

router.use('/meetings', require('./meeting.routes'));
// /health is mounted in server.js ahead of authenticate; a health check carries no token.

module.exports = router;
