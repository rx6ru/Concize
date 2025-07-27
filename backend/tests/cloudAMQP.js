require('dotenv').config(); 

const amqp = require('amqplib');

const amqpUrl = process.env.CLOUDAMQP_URL

async function testAmqpConnection() {
  console.log(`Attempting to connect to CloudAMQP at: ${amqpUrl}`);
  try {
    const connection = await amqp.connect(amqpUrl);
    console.log('Successfully connected to CloudAMQP!');

    // Close the connection immediately after successful test
    await connection.close();
    console.log('Connection closed.');
  } catch (error) {
    console.error('Failed to connect to CloudAMQP:', error.message);
    console.error('Please check your AMQP_URL and network connection.');
  }
}

testAmqpConnection();