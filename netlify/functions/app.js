const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const { Server } = require('socket.io');

let channel, connection;
const activeSessions = new Map();

async function connectQueue() {
  try {
    console.log('Attempting to connect to RabbitMQ...');
    console.log('RABBITMQ_URL:', process.env.RABBITMQ_URL ? 'Configured' : 'Not configured');
    
    if (!process.env.RABBITMQ_URL) {
      console.error('RABBITMQ_URL not configured');
      return null;
    }

    console.log('Establishing connection...');
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    console.log('Connection established');

    console.log('Creating channel...');
    channel = await connection.createChannel();
    console.log('Channel created');

    // Check if queue exists first
    try {
      console.log('Checking existing queue...');
      await channel.checkQueue("api_queue");
      console.log('Queue exists, skipping assertion');
    } catch (error) {
      console.log('Queue does not exist, creating new queue...');
      await channel.assertQueue("api_queue", {
        durable: true,
        arguments: {
          'x-message-ttl': 60000,
          'x-max-length': 1000,
          'x-overflow': 'reject-publish',
          'x-queue-mode': 'lazy'
        }
      });
      console.log('Queue created successfully');
    }

    await channel.prefetch(1);
    console.log("Successfully connected to RabbitMQ");
    return channel;
  } catch (error) {
    console.error("RabbitMQ connection error details:", {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errno: error.errno
    });
    return null;
  }
}

async function processMessage(userInput, sessionId) {
  try {
    console.log('Processing message...');
    console.log('OpenAI API Key:', process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured');

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: 'https://api.deepseek.com/v1'
    });

    let sessionContext = activeSessions.get(sessionId) || [];
    sessionContext.push({ role: "user", content: userInput });
    
    console.log('Sending request to OpenAI...');
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: sessionContext
    });
    console.log('Received response from OpenAI');

    const assistantMessage = {
      role: response.choices[0].message.role,
      content: response.choices[0].message.content
    };
    
    sessionContext.push(assistantMessage);
    
    if (sessionContext.length > 10) {
      sessionContext = sessionContext.slice(-10);
    }
    
    activeSessions.set(sessionId, sessionContext);
    return assistantMessage;
  } catch (error) {
    console.error("Error processing message details:", {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errno: error.errno
    });
    throw error;
  }
}

exports.handler = async function(event, context) {
  console.log('Handler function started');
  console.log('HTTP Method:', event.httpMethod);
  
  // Handle CORS
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

  let mqChannel = null;
  
  try {
    console.log('Parsing request body...');
    const body = JSON.parse(event.body);
    const { query: userInput, sessionId } = body;

    console.log('Request validation...');
    if (!userInput || !sessionId) {
      console.error('Missing required fields:', { userInput: !!userInput, sessionId: !!sessionId });
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'Query and sessionId are required' })
      };
    }

    console.log('Attempting RabbitMQ connection...');
    mqChannel = await connectQueue();
    
    if (mqChannel) {
      console.log('Sending message to RabbitMQ queue...');
      await mqChannel.sendToQueue(
        "api_queue",
        Buffer.from(JSON.stringify({ userInput, sessionId })),
        { 
          persistent: true,
          messageId: Date.now().toString(),
          timestamp: Date.now(),
          expiration: '60000'
        }
      );
      console.log('Message sent to RabbitMQ queue');
    } else {
      console.log('RabbitMQ connection not established, proceeding without queueing');
    }

    console.log('Processing message directly...');
    const result = await processMessage(userInput, sessionId);

    if (mqChannel) {
      console.log('Closing RabbitMQ connections...');
      await channel.close();
      await connection.close();
      console.log('RabbitMQ connections closed');
    }

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
    console.error('Handler error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errno: error.errno
    });
    
    if (mqChannel) {
      try {
        console.log('Attempting to close RabbitMQ connections after error...');
        await channel.close();
        await connection.close();
        console.log('RabbitMQ connections closed after error');
      } catch (closeError) {
        console.error('Error closing RabbitMQ connection:', {
          message: closeError.message,
          stack: closeError.stack
        });
      }
    }
    
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