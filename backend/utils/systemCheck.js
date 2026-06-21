const amqp = require('amqplib');
const { QdrantClient } = require('@qdrant/js-client-rest');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static');
const config = require('../configs/appConfig');
const { createLogger } = require('./logger');

const logger = createLogger('systemCheck');

/**
 * Verifies system dependencies before server startup.
 * Logs status for each component.
 * @returns {Promise<void>} Resolves if all checks pass, rejects if any fail.
 */
const performSystemCheck = async () => {
    logger.info('🚀 Starting System Health Checks...');

    // 1. Binaries Check
    try {
        if (!ffmpegPath || !ffprobePath) {
            throw new Error('FFmpeg or FFprobe binaries not found');
        }
        // Simple check to ensure paths are strings and look valid
        logger.info(`✅ Binaries verified (ffmpeg: ${ffmpegPath})`);
    } catch (error) {
        logger.error('❌ Binary check failed', { error: error.message });
        throw error;
    }

    // 2. Postgres Check
    try {
        const { query } = require('../db/pg');
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Postgres connection timed out')), 5000)
        );
        await Promise.race([query('SELECT 1'), timeoutPromise]);
        logger.info('✅ Postgres connection verified');
    } catch (error) {
        logger.error('❌ Postgres check failed', { error: error.message });
        throw error;
    }

    // 3. RabbitMQ Check
    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('RabbitMQ connection timed out')), 5000)
        );
        const connectionPromise = amqp.connect(config.queues.CLOUDAMQP_URL);

        const connection = await Promise.race([connectionPromise, timeoutPromise]);

        logger.info('✅ RabbitMQ connection verified');
        await connection.close();
    } catch (error) {
        logger.error('❌ RabbitMQ check failed', { error: error.message });
        throw error;
    }

    // 4. Qdrant Check
    try {
        const client = new QdrantClient({
            url: config.database.QDRANT_URL,
            apiKey: config.database.QDRANT_API_KEY,
            timeout: 5000 // Client-side timeout
        });

        // Use verify/health check if available, or lightweight getCollections
        await client.getCollections();
        logger.info('✅ Qdrant connection verified');
    } catch (error) {
        logger.error('❌ Qdrant check failed', { error: error.message });
        throw error;
    }

    logger.info('✨ All systems operational. Starting server...');
};

module.exports = { performSystemCheck };
