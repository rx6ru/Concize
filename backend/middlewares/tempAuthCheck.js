const crypto = require('crypto');
const config = require('../configs');

const tempAuthCheck = (req, res, next) => {
    const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
    const allowedCodes = config.ALLOWED_AUTH_CODES;

    // Fail closed: if config is missing or invalid, deny all requests
    if (!allowedCodes || !Array.isArray(allowedCodes) || allowedCodes.length === 0) {
        console.error(`AUTH_ERROR: Auth configuration missing or invalid. IP=${clientIP}`);
        return res.status(401).json({ error: "Unauthorized: Auth configuration missing." });
    }

    // Check Header
    const providedCode = req.headers['x-auth-code'];

    if (!providedCode) {
        console.warn(`AUTH_LOG: IP=${clientIP} result=FAIL reason=no_code_provided`);
        return res.status(401).json({ error: "Unauthorized: No authentication code provided." });
    }

    // Use timing-safe comparison to prevent timing attacks
    const isValidCode = allowedCodes.some(code => {
        if (code.length !== providedCode.length) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(code), Buffer.from(providedCode));
        } catch {
            return false;
        }
    });

    if (isValidCode) {
        console.log(`AUTH_LOG: IP=${clientIP} result=SUCCESS`);
        return next();
    } else {
        console.warn(`AUTH_LOG: IP=${clientIP} result=FAIL reason=invalid_code`);
        return res.status(401).json({ error: "Unauthorized: Invalid authentication code." });
    }
};

module.exports = tempAuthCheck;

