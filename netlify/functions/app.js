const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const { Server } = require('socket.io');

let channel, connection;
const activeSessions = new Map();

async function connectQueue() {
  try {
    console.log('Attempting to connect to RabbitMQ...');
    
    if (!process.env.RABBITMQ_URL) {
      console.error('RABBITMQ_URL not configured');
      return null;
    }

    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    
    // Delete the queue if it exists
    try {
      await channel.deleteQueue("api_queue");
      console.log('Existing queue deleted');
    } catch (error) {
      console.log('No existing queue to delete');
    }

    // Create new queue with consistent settings
    await channel.assertQueue("api_queue", {
      durable: true,
      arguments: {
        'x-message-ttl': 60000,
        'x-max-length': 1000,
        'x-overflow': 'reject-publish',
        'x-queue-mode': 'lazy'
      }
    });

    await channel.prefetch(1);
    console.log("Successfully connected to RabbitMQ");
    return channel;
  } catch (error) {
    console.error("RabbitMQ connection error:", error);
    return null;
  }
}

async function processMessage(userInput, sessionId) {
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: 'https://api.deepseek.com/v1'
    });

    let sessionContext = activeSessions.get(sessionId) || [];
    sessionContext.push({ role: "user", content: userInput });
    
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
    return assistantMessage;
  } catch (error) {
    console.error("Error processing message:", error);
    throw error;
  }
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
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let mqChannel = null;
  
  try {
    const body = JSON.parse(event.body);
    const { query: userInput, sessionId } = body;

    if (!userInput || !sessionId) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'Query and sessionId are required' })
      };
    }

    mqChannel = await connectQueue();
    
    if (mqChannel) {
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
    }

    const result = await processMessage(userInput, sessionId);

    if (mqChannel) {
      await channel.close();
      await connection.close();
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
    if (mqChannel) {
      try {
        await channel.close();
        await connection.close();
      } catch (closeError) {
        console.error('Error closing RabbitMQ connection:', closeError);
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