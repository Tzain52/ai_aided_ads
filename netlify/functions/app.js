const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const { Server } = require('socket.io');

let channel, connection;
const activeSessions = new Map();
const processingQueue = new Map();

async function connectQueue() {
  try {
    console.log('Attempting to connect to RabbitMQ...');
    
    if (!process.env.RABBITMQ_URL) {
      console.error('RABBITMQ_URL not configured');
      throw new Error('RABBITMQ_URL not configured');
    }

    console.log('Establishing connection to RabbitMQ...');
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    
    console.log('Creating queue with consistent settings...');
    const queueName = "api_queue";
    
    // Delete the queue first to ensure clean state
    try {
      await channel.deleteQueue(queueName);
    } catch (err) {
      console.log('Queue did not exist or could not be deleted:', err.message);
    }

    // Create queue with consistent settings
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-message-ttl': 300000, // 5 minutes TTL
        'x-max-length': 1000,
        'x-overflow': 'reject-publish',
        'x-queue-mode': 'lazy'
      }
    });

    // Set prefetch to handle multiple messages
    await channel.prefetch(5);
    console.log("Successfully connected to RabbitMQ and configured queue");
    return channel;
  } catch (error) {
    console.error("RabbitMQ connection error:", error);
    throw error;
  }
}

async function publishToQueue(data) {
  try {
    if (!channel) {
      channel = await connectQueue();
      if (!channel) throw new Error('Failed to connect to RabbitMQ');
    }

    const message = Buffer.from(JSON.stringify(data));
    await channel.sendToQueue("api_queue", message, {
      persistent: true,
      expiration: 300000 // 5 minutes
    });

    return true;
  } catch (error) {
    console.error("Error publishing to queue:", error);
    throw error;
  }
}

async function consumeFromQueue(data) {
  try {
    if (!channel) {
      channel = await connectQueue();
      if (!channel) throw new Error('Failed to connect to RabbitMQ');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Queue processing timeout'));
      }, 30000); // 30 seconds timeout

      const consumer = channel.consume("api_queue", async (msg) => {
        if (msg !== null) {
          try {
            const messageData = JSON.parse(msg.content.toString());
            if (messageData.sessionId === data.sessionId) {
              clearTimeout(timeout);
              channel.ack(msg);
              channel.cancel(consumer.consumerTag); // Stop consuming after finding our message
              resolve(messageData);
            } else {
              // Put back messages for other sessions
              channel.nack(msg, false, true);
            }
          } catch (error) {
            console.error("Error processing message:", error);
            channel.nack(msg, false, false);
          }
        }
      });
    });
  } catch (error) {
    console.error("Error consuming from queue:", error);
    throw error;
  }
}

async function processMessage(userInput, sessionId) {
  try {
    console.log(`Processing message for session ${sessionId}`);
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: 'https://api.deepseek.com/v1'
    });

    let sessionContext = activeSessions.get(sessionId) || [];
    const userMessage = { role: "user", content: userInput };
    sessionContext.push(userMessage);
    
    console.log('Sending request to OpenAI...');
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: sessionContext
    });

    const assistantMessage = {
      role: response.choices[0].message.role,
      content: response.choices[0].message.content
    };
    
    console.log(`Received response from OpenAI (${assistantMessage.content.length} chars)`);
    
    sessionContext.push(assistantMessage);
    
    if (sessionContext.length > 10) {
      console.log(`Trimming message history for session ${sessionId}`);
      sessionContext = sessionContext.slice(-10);
    }
    
    activeSessions.set(sessionId, sessionContext);
    
    // Emit updated sessions to all connected admin clients
    if (io) {
      io.emit('sessions', Array.from(activeSessions.entries()));
    }
    
    return assistantMessage;
  } catch (error) {
    console.error("Error processing message:", error);
    console.error("Stack trace:", error.stack);
    throw error;
  }
}

// Initialize Socket.IO
const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('Admin client connected');

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
  console.log('Received request:', event.httpMethod);
  
  if (event.httpMethod === 'OPTIONS') {
    console.log('Handling OPTIONS request');
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
    console.log(`Method not allowed: ${event.httpMethod}`);
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    console.log('Processing POST request...');
    const body = JSON.parse(event.body);
    const { query: userInput, sessionId } = body;

    if (!userInput || !sessionId) {
      console.log('Missing required fields:', { userInput: !!userInput, sessionId: !!sessionId });
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'Query and sessionId are required' })
      };
    }

    // Check if this session is already being processed
    if (processingQueue.has(sessionId)) {
      console.log(`Session ${sessionId} is already being processed, queueing request`);
      await publishToQueue({ userInput, sessionId });
      
      try {
        const result = await consumeFromQueue({ sessionId });
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
        console.error('Error waiting for queued response:', error);
        throw error;
      }
    }

    // Mark this session as being processed
    processingQueue.set(sessionId, true);

    try {
      console.log('Processing message...');
      const result = await processMessage(userInput, sessionId);

      // Publish the result to queue for any waiting requests
      await publishToQueue({
        sessionId,
        response: result.content
      });

      console.log('Sending successful response');
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
    } finally {
      // Clear the processing flag
      processingQueue.delete(sessionId);
    }

  } catch (error) {
    console.error('Error in handler:', error);
    console.error('Stack trace:', error.stack);
    
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