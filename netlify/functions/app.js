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

    console.log('Establishing connection to RabbitMQ...');
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    
    console.log('Creating new queue with updated settings...');
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
    console.log("Successfully connected to RabbitMQ and configured queue");
    return channel;
  } catch (error) {
    console.error("RabbitMQ connection error:", error.message);
    console.error("Stack trace:", error.stack);
    return null;
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
    sessionContext.push({ role: "user", content: userInput });
    
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
    return assistantMessage;
  } catch (error) {
    console.error("Error processing message:", error.message);
    console.error("Stack trace:", error.stack);
    throw error;
  }
}

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

    console.log('Processing message...');
    const result = await processMessage(userInput, sessionId);

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

  } catch (error) {
    console.error('Error in handler:', error.message);
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