// testConsumer.js

// This file is a minimal script to test the RabbitMQ consumer connection
// It should be run independently from your main application.

const amqp = require('amqplib');
const config = require('../utils/config'); // Ensure this path is correct

const audioQueue = 'audio_queue';
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

const runTestConsumer = async () => {
    try {
        console.log('Test Consumer: Attempting to connect to RabbitMQ...');
        const conn = await amqp.connect(CLOUDAMQP_URL);
        const ch = await conn.createChannel();
        await ch.assertQueue(audioQueue, { durable: true });

        console.log('Test Consumer: Connected and waiting for messages in the queue...');

        ch.consume(audioQueue, async (msg) => {
            if (msg === null) {
                console.log('Test Consumer: Consumer cancelled.');
                return;
            }

            console.log('Test Consumer: === MESSAGE RECEIVED ===');
            try {
                // We will try to parse the message to see if it's valid JSON
                const messageContent = JSON.parse(msg.content.toString());
                console.log('Test Consumer: Parsed message:', messageContent);

                // Acknowledge the message so it's removed from the queue
                ch.ack(msg);
                console.log('Test Consumer: Message acknowledged and removed from queue.');

            } catch (error) {
                console.error('Test Consumer: Error processing message:', error);
                // Nack the message and requeue it on error
                ch.nack(msg, false, true);
            }
        }, { noAck: false });

    } catch (error) {
        console.error('Test Consumer: Failed to start:', error);
    }
};

runTestConsumer();