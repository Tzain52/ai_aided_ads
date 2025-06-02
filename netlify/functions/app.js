const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const { Server } = require('socket.io');

let channel, connection;
const activeSessions = new Map();
const processingQueue = new Map();
const QUEUE_NAME = "api_queue";

async function connectQueue() {
  try {
    if (!process.env.RABBITMQ_URL) {
      throw new Error('RABBITMQ_URL not configured');
    }

    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    
    // Delete the queue first to ensure clean state
    try {
      await channel.deleteQueue(QUEUE_NAME);
    } catch (err) {
      console.log('Queue deletion failed or queue did not exist:', err.message);
    }
    
    // Create queue with consistent settings
    await channel.assertQueue(QUEUE_NAME, {
      durable: true,
      arguments: {
        'x-message-ttl': 60000, // Set to 1 minute
        'x-max-length': 1000,
        'x-overflow': 'reject-publish',
        'x-queue-mode': 'lazy'
      }
    });

    // Set prefetch to 1 to ensure fair distribution
    await channel.prefetch(1);
    
    // Setup consumer
    await setupQueueConsumer();
    
    return channel;
  } catch (error) {
    console.error("RabbitMQ connection error:", error);
    throw error;
  }
}

async function setupQueueConsumer() {
  try {
    await channel.consume(QUEUE_NAME, async (msg) => {
      if (msg !== null) {
        try {
          const data = JSON.parse(msg.content.toString());
          const { sessionId, userInput } = data;
          
          if (!processingQueue.has(sessionId)) {
            processingQueue.set(sessionId, true);
            try {
              const result = await processMessage(userInput, sessionId);
              channel.ack(msg);
              
              // Notify waiting clients
              if (io) {
                io.emit(`response_${sessionId}`, {
                  response: result.content,
                  status: 'success'
                });
                // Update sessions list
                io.emit('sessions', Array.from(activeSessions.entries()));
              }
            } finally {
              processingQueue.delete(sessionId);
            }
          } else {
            // Requeue if session is being processed
            channel.nack(msg, false, true);
          }
        } catch (error) {
          console.error("Error processing message:", error);
          channel.nack(msg, false, false);
        }
      }
    });
  } catch (error) {
    console.error("Error setting up consumer:", error);
    throw error;
  }
}

async function publishToQueue(data) {
  try {
    if (!channel) {
      channel = await connectQueue();
    }

    return await channel.sendToQueue(
      QUEUE_NAME,
      Buffer.from(JSON.stringify(data)),
      {
        persistent: true,
        expiration: 60000 // Match the queue TTL
      }
    );
  } catch (error) {
    console.error("Error publishing to queue:", error);
    throw error;
  }
}

async function processMessage(userInput, sessionId) {
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: 'https://api.deepseek.com/v1'
    });

    let sessionContext = activeSessions.get(sessionId) || [];
    const userMessage = { role: "user", content: userInput };
    sessionContext.push(userMessage);
    
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: sessionContext
    });

    const assistantMessage = {
      role: response.choices[0].message.role,
      content: response.choices[0].message.content
    };
    
    sessionContext.push(assistantMessage);
    
    if (sessionContext.length > 10) {
      sessionContext = sessionContext.slice(-10);
    }
    
    activeSessions.set(sessionId, sessionContext);
    
    if (io) {
      io.emit('sessions', Array.from(activeSessions.entries()));
    }
    
    return assistantMessage;
  } catch (error) {
    console.error("Error processing message:", error);
    throw error;
  }
}

const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('New admin connection');
  
  socket.on('getSessions', () => {
    socket.emit('sessions', Array.from(activeSessions.entries()));
  });

  socket.on('clearSession', (sessionId) => {
    if (activeSessions.has(sessionId)) {
      activeSessions.delete(sessionId);
      socket.emit('sessionCleared');
      io.emit('sessions', Array.from(activeSessions.entries()));
    }
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
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { query: userInput, sessionId } = body;

    if (!userInput || !sessionId) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'Query and sessionId are required' })
      };
    }

    // Always publish to queue first
    await publishToQueue({ userInput, sessionId });

    // Wait for response with timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), 30000)
    );

    const responsePromise = new Promise((resolve) => {
      io.once(`response_${sessionId}`, (data) => resolve(data));
    });

    const result = await Promise.race([responsePromise, timeoutPromise]);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        response: result.response,
        message_limit_reached: false
      })
    };

  } catch (error) {
    console.error('Error in handler:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        error: 'An error occurred while processing your request. Please try again.',
        details: error.message
      })
    };
  }
};