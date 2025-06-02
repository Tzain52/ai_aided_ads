const { OpenAI } = require('openai');
const amqp = require('amqplib');

let channel, connection;

async function connectQueue() {
  try {
    // CloudAMQP connection URL format: amqps://username:password@hostname/vhost
    const opts = {
      heartbeat: 60,
      connection_timeout: 10000,
      protocol: 'amqps'  // Use AMQPS for CloudAMQP
    };
    
    connection = await amqp.connect(process.env.RABBITMQ_URL, opts);
    channel = await connection.createChannel();
    
    await channel.assertQueue("api_queue", {
      durable: true,
      arguments: {
        'x-message-ttl': 60000,
        'x-max-length': 1000
      }
    });
  } catch (error) {
    console.error("Error connecting to RabbitMQ:", error);
    throw error;
  }
}

async function processMessage(userInput) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
  });

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: userInput }]
  });

  return {
    role: response.choices[0].message.role,
    content: response.choices[0].message.content
  };
}

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    await connectQueue();
    
    const body = JSON.parse(event.body);
    const userInput = body.query?.trim();

    if (!userInput) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'Query cannot be empty' })
      };
    }

    // Send message to queue
    await channel.sendToQueue(
      "api_queue",
      Buffer.from(JSON.stringify({ userInput })),
      { persistent: true }
    );

    // Process message from queue
    const result = await new Promise((resolve, reject) => {
      channel.consume("api_queue", async (data) => {
        try {
          const inputData = JSON.parse(data.content);
          const response = await processMessage(inputData.userInput);
          channel.ack(data);
          resolve(response);
        } catch (error) {
          channel.ack(data);
          reject(error);
        }
      });
    });

    // Cleanup
    if (channel) await channel.close();
    if (connection) await connection.close();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        response: result.content,
        message_limit_reached: false
      })
    };

  } catch (error) {
    console.error('Error:', error);
    // Ensure cleanup on error
    if (channel) await channel.close();
    if (connection) await connection.close();
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: error.message || 'Internal Server Error' })
    };
  }
};