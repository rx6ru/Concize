const crypto = require('crypto');
const config = require('../configs/appConfig');
const { createLogger } = require('../utils/logger');

const logger = createLogger('authMiddleware');

const tempAuthCheck = (req, res, next) => {
    const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
    const validAuthCodes = config.auth.ALLOWED_AUTH_CODES || [];

    // Skip auth for CORS preflight
    if (req.method === 'OPTIONS') {
        return next();
    }

    // Fail closed: if config is missing or invalid, deny all requests
    if (!validAuthCodes || !Array.isArray(validAuthCodes) || validAuthCodes.length === 0) {
        logger.error('Auth configuration missing or invalid', { ip: clientIP });
        return res.status(401).json({ error: "Unauthorized: Auth configuration missing." });
    }

    // Check Header
    const providedCode = req.headers['x-auth-code'];

    if (!providedCode) {
        logger.warn('Auth failed: no code provided', { ip: clientIP });
        return res.status(401).json({ error: "Unauthorized: No authentication code provided." });
    }

    // Use timing-safe comparison to prevent timing attacks
    const isValidCode = validAuthCodes.some(code => {
        if (code.length !== providedCode.length) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(code), Buffer.from(providedCode));
        } catch {
            return false;
        }
    });

    if (isValidCode) {
        logger.info('Auth success', { ip: clientIP });
        return next();
    } else {
        logger.warn('Auth failed: invalid code', { ip: clientIP });
        return res.status(401).json({ error: "Unauthorized: Invalid authentication code." });
    }
};

module.exports = tempAuthCheck;
