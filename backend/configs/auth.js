// configs/auth.js
// Authentication configuration

const ALLOWED_AUTH_CODES = (process.env.ALLOWED_AUTH_CODES && process.env.ALLOWED_AUTH_CODES.trim() !== '')
    ? process.env.ALLOWED_AUTH_CODES.split(',').map(c => c.trim()).filter(c => c)
    : [];

module.exports = {
    ALLOWED_AUTH_CODES,
};
