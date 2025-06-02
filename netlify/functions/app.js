const { OpenAI } = require('openai');
const amqp = require('amqplib');

let channel, connection;

async function connectQueue() {
  try {
    if (!process.env.RABBITMQ_URL) {
      throw new Error('RABBITMQ_URL environment variable is not set');
    }

    const opts = {
      heartbeat: 60,
      connection_timeout: 10000
    };
    
    connection = await amqp.connect(process.env.RABBITMQ_URL, opts);
    channel = await connection.createChannel();
    
    // Configure queue with persistence settings
    await channel.assertQueue("api_queue", {
      durable: true, // Queue survives broker restart
      arguments: {
        'x-message-ttl': 1209600000, // Messages expire after 14 days
        'x-max-length': 10000, // Store up to 10000 messages
        'x-overflow': 'reject-publish', // Reject new messages when queue is full
        'x-queue-mode': 'lazy' // Optimize for message persistence over performance
      }
    });

    // Enable publisher confirms
    await channel.confirmSelect();

    // Set prefetch to 1 to ensure even distribution of messages
    await channel.prefetch(1);
    
    console.log("Successfully connected to RabbitMQ");
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

    // Send message to queue with persistence
    await channel.sendToQueue(
      "api_queue",
      Buffer.from(JSON.stringify({ userInput })),
      { 
        persistent: true, // Message survives broker restart
        messageId: Date.now().toString(), // Unique identifier for message
        timestamp: Date.now(), // Timestamp for message tracking
        expiration: '1209600000' // Message expires after 14 days
      }
    );

    // Process message from queue with timeout
    const result = await Promise.race([
      new Promise((resolve, reject) => {
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
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout')), 30000)
      )
    ]);

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