const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const { Server } = require('socket.io');

let channel, connection;
const activeSessions = new Map();

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
      durable: true,
      arguments: {
        'x-message-ttl': 1209600000,
        'x-max-length': 10000,
        'x-overflow': 'reject-publish',
        'x-queue-mode': 'lazy'
      }
    });

    await channel.confirmSelect();
    await channel.prefetch(1);
    
    console.log("Successfully connected to RabbitMQ");
  } catch (error) {
    console.error("Error connecting to RabbitMQ:", error);
    throw error;
  }
}

async function processMessage(userInput, sessionId) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
  });

  // Get or create session context
  let sessionContext = activeSessions.get(sessionId) || [];
  
  // Add user message to context
  sessionContext.push({ role: "user", content: userInput });
  
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: sessionContext
  });

  // Add assistant response to context
  const assistantMessage = {
    role: response.choices[0].message.role,
    content: response.choices[0].message.content
  };
  sessionContext.push(assistantMessage);

  // Limit context to last 10 messages
  if (sessionContext.length > 10) {
    sessionContext = sessionContext.slice(-10);
  }

  // Update session context
  activeSessions.set(sessionId, sessionContext);

  return assistantMessage;
}

// Admin panel setup
const app = express();
const io = new Server(app);

io.on('connection', (socket) => {
  // Send active sessions data
  socket.emit('sessions', Array.from(activeSessions.entries()));

  // Handle admin commands
  socket.on('clearSession', (sessionId) => {
    activeSessions.delete(sessionId);
    io.emit('sessionCleared', sessionId);
  });

  socket.on('getSessions', () => {
    socket.emit('sessions', Array.from(activeSessions.entries()));
  });
});

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
    const { query: userInput, sessionId } = body;

    if (!userInput || !sessionId) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'Query and sessionId are required' })
      };
    }

    await channel.sendToQueue(
      "api_queue",
      Buffer.from(JSON.stringify({ userInput, sessionId })),
      { 
        persistent: true,
        messageId: Date.now().toString(),
        timestamp: Date.now(),
        expiration: '1209600000'
      }
    );

    const result = await Promise.race([
      new Promise((resolve, reject) => {
        channel.consume("api_queue", async (data) => {
          try {
            const inputData = JSON.parse(data.content);
            const response = await processMessage(inputData.userInput, inputData.sessionId);
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