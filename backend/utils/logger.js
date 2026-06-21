// utils/logger.js
'use strict';

const winston = require('winston');
const { getContext } = require('./context');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Injects the ambient request correlation id (if any) into every log line, so one id traces a
// request across all modules. No-op outside a request context.
const injectContext = winston.format((info) => {
    const ctx = getContext();
    if (ctx && ctx.requestId && info.requestId === undefined) {
        info.requestId = ctx.requestId;
    }
    return info;
});

// Human-readable format for development
const devFormat = combine(
    injectContext(),
    colorize({ all: true }),
    timestamp({ format: 'HH:mm:ss' }),
    errors({ stack: true }),
    printf(({ timestamp, level, message, module, requestId, ...meta }) => {
        const mod = module ? `[${module}]` : '';
        const rid = requestId ? ` (${String(requestId).slice(0, 8)})` : '';
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level} ${mod}${rid} ${message}${metaStr}`;
    })
);

// Structured JSON format for production (log aggregation friendly)
const prodFormat = combine(
    injectContext(),
    timestamp(),
    errors({ stack: true }),
    json()
);

const rootLogger = winston.createLogger({
    level: LOG_LEVEL,
    format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
    transports: [
        new winston.transports.Console(),
    ],
    // Don't exit on uncaught exceptions — let the process manager decide
    exitOnError: false,
});

/**
 * Creates a child logger tagged with a module name.
 * Usage:
 *   const logger = require('../utils/logger').createLogger('audioController');
 *   logger.info('File uploaded', { fileId, jobId });
 *   logger.error('Upload failed', { error: err.message });
 *
 * @param {string} moduleName - Name of the module (e.g. 'audioController', 'transcriptionWorker').
 * @returns {winston.Logger} A child logger with the module metadata attached.
 */
function createLogger(moduleName) {
    return rootLogger.child({ module: moduleName });
}

module.exports = { createLogger };
