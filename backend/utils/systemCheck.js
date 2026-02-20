const mongoose = require('mongoose');
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

    // 2. MongoDB Check
    try {
        // Mongoose should already be connecting/connected via connectToMongo in index.js
        // We wait up to 5 seconds for it to be ready
        let attempts = 0;
        while (mongoose.connection.readyState !== 1 && attempts < 5) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (mongoose.connection.readyState === 1) {
            logger.info('✅ MongoDB connection verified');
        } else {
            throw new Error('Mongoose connection not ready after 5s');
        }
    } catch (error) {
        logger.error('❌ MongoDB check failed', { error: error.message });
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
