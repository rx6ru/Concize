// routes/v1/healthRoutes.js
const express = require('express');
const router = express.Router();

/**
 * @route GET /api/v1/health
 * @desc Quick health check endpoint to verify backend server is running and reachable.
 * @access Public
 */
router.get('/', (req, res) => {
    // We could add deeper database checks here later, 
    // but a simple 200 OK is enough for basic connectivity pooling.
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'Concize Backend is operational'
    });
});

module.exports = router;
