// V1 API route aggregator.

const router = require('express').Router();

router.use('/meetings', require('./meeting.routes'));
router.use('/health', require('./health.routes'));

module.exports = router;
