const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    // A simple 200 OK is enough here; no deeper checks needed yet.
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'Concize Backend is operational'
    });
});

module.exports = router;
