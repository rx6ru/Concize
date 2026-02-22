// routes/v1/index.js
// V1 API route aggregator
// All v1 domain routers are mounted here and exported as a single router.

const router = require('express').Router();

router.use('/audios', require('./audioRoutes'));
router.use('/meeting', require('./meetingRoutes'));
router.use('/transcription', require('./transcRoutes'));
router.use('/chat', require('./chatRoutes'));
router.use('/health', require('./healthRoutes'));

module.exports = router;
