'use strict';

const { createLogger } = require('../../core/logger');
const logger = createLogger('http');

/**
 * Incoming:  → POST /api/v1/audio
 * Outgoing:  ← POST /api/v1/audio 202 45ms
 *
 * Skips health-check / readiness endpoints to reduce noise.
 */
function requestLogger(req, res, next) {
    if (req.path === '/health' || req.path === '/ready') {
        return next();
    }

    const start = Date.now();

    logger.http(`→ ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
    });

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
