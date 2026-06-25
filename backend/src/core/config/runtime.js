// Server and environment configuration

module.exports = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    DEV_PREFIX: process.env.DEV_PREFIX || '',
};
