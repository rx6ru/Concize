// Message queue configuration

const DEV_PREFIX = process.env.DEV_PREFIX || '';

module.exports = {
    AUDIO_QUEUE: `${DEV_PREFIX}audio_queue`,
    SUMMARY_QUEUE: process.env.SUMMARY_QUEUE || 'summary_queue',
    CLOUDAMQP_URL: process.env.CLOUDAMQP_URL,
};
