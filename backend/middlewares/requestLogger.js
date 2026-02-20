// middlewares/requestLogger.js
'use strict';

const { createLogger } = require('../utils/logger');
const logger = createLogger('http');

/**
 * Express middleware that logs every HTTP request and its response.
 *
 * Incoming:  → POST /api/v1/audio
 * Outgoing:  ← POST /api/v1/audio 202 45ms
 *
 * Skips health-check / readiness endpoints to reduce noise.
 */
function requestLogger(req, res, next) {
    // Skip noisy health-check paths
    if (req.path === '/health' || req.path === '/ready') {
        return next();
    }

    const start = Date.now();

    logger.http(`→ ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
    });

    // Hook into response finish to log the outcome
    res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 400 ? 'warn' : 'http';

        logger[level](`← ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
            status: res.statusCode,
            duration,
        });
    });

    next();
}

module.exports = requestLogger;
