const config = require('../utils/config');

const tempAuthCheck = (req, res, next) => {
    // List of allowed codes from config
    const allowedCodes = config.ALLOWED_AUTH_CODES;

    // Check Header
    const providedCode = req.headers['x-auth-code'];


    if (!providedCode) {
        return res.status(401).json({ error: "Unauthorized: No authentication code provided." });
    }

    if (allowedCodes.includes(providedCode)) {
        return next();
    } else {
        return res.status(401).json({ error: "Unauthorized: Invalid authentication code." });
    }
};

module.exports = tempAuthCheck;
