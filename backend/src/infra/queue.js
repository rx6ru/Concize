// Shared, long-lived RabbitMQ publisher for the API process.
// RabbitMQ/AMQP assume long-lived connections: opening one per message is an anti-pattern (~7 TCP round-trips per handshake) and quickly exhausts CloudAMQP's connection cap (shared "Little Lemur" = 20).
// We keep ONE connection + ONE confirm channel, reused across all publishes, and reconnect transparently if the broker drops it.

const amqp = require('amqplib');
const config = require('../core/config');
const { createLogger } = require('../core/logger');

const logger = createLogger('amqp');

let connection = null;
let channel = null;
let connecting = null; // in-flight connect promise (de-dupes concurrent callers)

async function _connect() {
    const conn = await amqp.connect(config.queues.CLOUDAMQP_URL);
    conn.on('close', () => { logger.warn('AMQP connection closed'); connection = null; channel = null; });
    conn.on('error', (e) => logger.error('AMQP connection error', { error: e.message }));

    const ch = await conn.createConfirmChannel();
    ch.on('close', () => { channel = null; });
    ch.on('error', (e) => logger.error('AMQP channel error', { error: e.message }));

    connection = conn;
    channel = ch;
    logger.info('AMQP publisher connection established');
    return ch;
}

/** Returns the shared confirm channel, (re)connecting if needed. */
async function getChannel() {
    if (channel) return channel;
    if (!connecting) {
        connecting = _connect().finally(() => { connecting = null; });
    }
    try {
        return await connecting;
    } catch (err) {
        connection = null;
        channel = null;
        throw err;
    }
}

/**
 * Publishes a durable message to a durable queue on the shared confirm channel,
 * waiting for the broker ack.
 * @param {string} queue
 * @param {Object} messageObj  serialized to JSON
 * @param {Object} [opts]      extra publish options (merged over { persistent: true })
 */
async function publishToQueue(queue, messageObj, opts = {}) {
    const ch = await getChannel();
    await ch.assertQueue(queue, { durable: true });
    ch.sendToQueue(queue, Buffer.from(JSON.stringify(messageObj)), { persistent: true, ...opts });
    await ch.waitForConfirms();
}

/** Closes the shared connection (graceful shutdown / tests). */
async function closeAmqp() {
    try { if (channel) await channel.close(); } catch { /* noop */ }
    try { if (connection) await connection.close(); } catch { /* noop */ }
    channel = null;
    connection = null;
}

/** Test seam: drop cached connection/channel so a fresh mock is picked up. */
function _resetForTests() {
    channel = null;
    connection = null;
    connecting = null;
}

module.exports = { getChannel, publishToQueue, closeAmqp, _resetForTests };
