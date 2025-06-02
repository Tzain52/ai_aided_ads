const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const { Server } = require('socket.io');

let channel, connection;
const activeSessions = new Map();
const processingQueue = new Map();
const QUEUE_NAME = "api_queue";

// Enhanced logging function
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] ${message}`, data);
}

async function connectQueue() {
    try {
        log('info', 'Attempting to connect to RabbitMQ');
        
        if (!process.env.RABBITMQ_URL) {
            throw new Error('RABBITMQ_URL not configured');
        }

        // Reuse existing connection if available
        if (connection && channel) {
            log('info', 'Reusing existing RabbitMQ connection');
            return channel;
        }

        connection = await amqp.connect(process.env.RABBITMQ_URL);
        log('info', 'Connected to RabbitMQ');
        
        channel = await connection.createChannel();
        log('info', 'Created RabbitMQ channel');
        
        // Check if queue exists before asserting
        try {
            await channel.checkQueue(QUEUE_NAME);
            log('info', 'Queue already exists, skipping assertion');
        } catch (error) {
            // Queue doesn't exist, create it
            const queueResult = await channel.assertQueue(QUEUE_NAME, {
                durable: true,
                arguments: {
                    'x-message-ttl': 60000,
                    'x-max-length': 1000,
                    'x-overflow': 'reject-publish',
                    'x-queue-mode': 'lazy'
                }
            });
            log('info', 'Queue created successfully', { queue: queueResult });
        }

        // Set prefetch to 1 to ensure fair distribution
        await channel.prefetch(1);
        log('info', 'Prefetch set to 1');
        
        // Setup consumer
        await setupQueueConsumer();
        
        // Handle connection closure
        connection.on('close', async (err) => {
            log('warn', 'RabbitMQ connection closed', { error: err?.message });
            channel = null;
            connection = null;
            // Attempt to reconnect after a delay
            setTimeout(connectQueue, 5000);
        });

        return channel;
    } catch (error) {
        log('error', 'RabbitMQ connection error', { error: error.message, stack: error.stack });
        throw error;
    }
}

async function setupQueueConsumer() {
    try {
        log('info', 'Setting up queue consumer');
        await channel.consume(QUEUE_NAME, async (msg) => {
            if (msg !== null) {
                try {
                    const data = JSON.parse(msg.content.toString());
                    const { sessionId, userInput } = data;
                    log('info', 'Processing message from queue', { sessionId });
                    
                    if (!processingQueue.has(sessionId)) {
                        processingQueue.set(sessionId, true);
                        log('info', 'Session processing started', { sessionId });
                        
                        try {
                            const result = await processMessage(userInput, sessionId);
                            channel.ack(msg);
                            log('info', 'Message processed successfully', { sessionId });
                            
                            // Notify waiting clients
                            if (io) {
                                io.emit(`response_${sessionId}`, {
                                    response: result.content,
                                    status: 'success'
                                });
                                io.emit('sessions', Array.from(activeSessions.entries()));
                                log('info', 'Clients notified of response', { sessionId });
                            }
                        } finally {
                            processingQueue.delete(sessionId);
                            log('info', 'Session processing completed', { sessionId });
                        }
                    } else {
                        log('info', 'Session already being processed, requeuing', { sessionId });
                        channel.nack(msg, false, true);
                    }
                } catch (error) {
                    log('error', 'Error processing message', { error: error.message, stack: error.stack });
                    channel.nack(msg, false, false);
                }
            }
        });
        log('info', 'Queue consumer setup complete');
    } catch (error) {
        log('error', 'Error setting up consumer', { error: error.message, stack: error.stack });
        throw error;
    }
}

async function publishToQueue(data) {
    try {
        log('info', 'Publishing message to queue', { sessionId: data.sessionId });
        
        if (!channel) {
            log('info', 'Channel not found, connecting to queue');
            channel = await connectQueue();
        }

        const result = await channel.sendToQueue(
            QUEUE_NAME,
            Buffer.from(JSON.stringify(data)),
            {
                persistent: true,
                expiration: 60000 // Match queue TTL
            }
        );
        log('info', 'Message published successfully', { sessionId: data.sessionId });
        return result;
    } catch (error) {
        log('error', 'Error publishing to queue', { error: error.message, stack: error.stack });
        throw error;
    }
}

async function processMessage(userInput, sessionId) {
    try {
        log('info', 'Processing message', { sessionId });
        
        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: 'https://api.deepseek.com/v1'
        });

        let sessionContext = activeSessions.get(sessionId) || [];
        const userMessage = { role: "user", content: userInput };
        sessionContext.push(userMessage);
        
        log('info', 'Sending request to OpenAI', { sessionId });
        const response = await client.chat.completions.create({
            model: "deepseek-chat",
            messages: sessionContext
        });
        log('info', 'Received response from OpenAI', { sessionId });

        const assistantMessage = {
            role: response.choices[0].message.role,
            content: response.choices[0].message.content
        };
        
        sessionContext.push(assistantMessage);
        
        if (sessionContext.length > 10) {
            log('info', 'Trimming session context', { sessionId });
            sessionContext = sessionContext.slice(-10);
        }
        
        activeSessions.set(sessionId, sessionContext);
        
        if (io) {
            io.emit('sessions', Array.from(activeSessions.entries()));
            log('info', 'Session list updated', { sessionId });
        }
        
        return assistantMessage;
    } catch (error) {
        log('error', 'Error processing message', { 
            sessionId,
            error: error.message,
            stack: error.stack
        });
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
    log('info', 'New admin connection established', { socketId: socket.id });
    
    socket.on('getSessions', () => {
        log('info', 'Sessions requested', { socketId: socket.id });
        socket.emit('sessions', Array.from(activeSessions.entries()));
    });

    socket.on('clearSession', (sessionId) => {
        log('info', 'Clear session requested', { sessionId, socketId: socket.id });
        if (activeSessions.has(sessionId)) {
            activeSessions.delete(sessionId);
            socket.emit('sessionCleared');
            io.emit('sessions', Array.from(activeSessions.entries()));
            log('info', 'Session cleared successfully', { sessionId });
        }
    });

    socket.on('disconnect', () => {
        log('info', 'Admin disconnected', { socketId: socket.id });
    });
});

exports.handler = async function(event, context) {
    log('info', 'Received request', { method: event.httpMethod });
    
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
        log('warn', 'Method not allowed', { method: event.httpMethod });
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const { query: userInput, sessionId } = body;

        if (!userInput || !sessionId) {
            log('warn', 'Invalid request', { hasInput: !!userInput, hasSessionId: !!sessionId });
            return { 
                statusCode: 400, 
                body: JSON.stringify({ error: 'Query and sessionId are required' })
            };
        }

        log('info', 'Publishing message to queue', { sessionId });
        await publishToQueue({ userInput, sessionId });

        // Wait for response with timeout
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), 30000)
        );

        const responsePromise = new Promise((resolve) => {
            io.once(`response_${sessionId}`, (data) => resolve(data));
        });

        const result = await Promise.race([responsePromise, timeoutPromise]);
        log('info', 'Response received', { sessionId });

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
        log('error', 'Error in handler', { 
            error: error.message,
            stack: error.stack
        });
        
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