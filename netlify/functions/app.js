const { OpenAI } = require('openai');
const amqp = require('amqplib');
const express = require('express');
const serverless = require('serverless-http');
const { Server } = require('socket.io');

const app = express();
const QUEUE_NAME = "api_queue";

let channel, connection;
const activeSessions = new Map();
const processingQueue = new Map();

// Enhanced logging function
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] ${message}`, data);
}

// Initialize Socket.IO with Express
const io = new Server({
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

// Socket.IO event handlers
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

async function connectQueue() {
    try {
        log('info', 'Attempting to connect to RabbitMQ');
        
        if (!process.env.RABBITMQ_URL) {
            throw new Error('RABBITMQ_URL not configured');
        }

        // If already connected, return existing channel
        if (channel && connection && connection.connection.serverProperties) {
            log('info', 'Using existing RabbitMQ connection');
            return channel;
        }

        // Close existing connections if they exist
        if (channel) {
            await channel.close();
            channel = null;
        }
        if (connection) {
            await connection.close();
            connection = null;
        }

        // Create new connection
        connection = await amqp.connect(process.env.RABBITMQ_URL);
        log('info', 'Connected to RabbitMQ');
        
        channel = await connection.createChannel();
        log('info', 'Created RabbitMQ channel');

        // Assert queue with updated settings
        await channel.assertQueue(QUEUE_NAME, {
            durable: true,
            arguments: {
                'x-message-ttl': 300000, // 5 minutes
                'x-max-length': 1000,
                'x-overflow': 'reject-publish'
            }
        });

        await channel.prefetch(1);
        
        // Set up error handlers
        connection.on('error', (err) => {
            log('error', 'RabbitMQ connection error', { error: err.message });
            channel = null;
            connection = null;
        });

        connection.on('close', () => {
            log('warn', 'RabbitMQ connection closed');
            channel = null;
            connection = null;
            // Attempt to reconnect after a delay
            setTimeout(() => {
                connectQueue().catch(err => {
                    log('error', 'Reconnection failed', { error: err.message });
                });
            }, 5000);
        });

        // Set up consumer
        await setupQueueConsumer();
        
        return channel;
    } catch (error) {
        log('error', 'RabbitMQ connection error', { error: error.message, stack: error.stack });
        // Clear invalid connections
        channel = null;
        connection = null;
        throw error;
    }
}

async function setupQueueConsumer() {
    if (!channel) {
        throw new Error('Channel not initialized');
    }

    try {
        log('info', 'Setting up queue consumer');
        await channel.consume(QUEUE_NAME, async (msg) => {
            if (msg === null) {
                log('warn', 'Received null message');
                return;
            }

            try {
                const data = JSON.parse(msg.content.toString());
                const { sessionId, userInput } = data;
                
                if (!processingQueue.has(sessionId)) {
                    processingQueue.set(sessionId, true);
                    try {
                        const result = await processMessage(userInput, sessionId);
                        channel.ack(msg);
                        
                        io.emit(`response_${sessionId}`, {
                            response: result.content,
                            status: 'success'
                        });
                        io.emit('sessions', Array.from(activeSessions.entries()));
                    } catch (error) {
                        log('error', 'Error processing message', { error: error.message });
                        channel.nack(msg, false, false);
                    } finally {
                        processingQueue.delete(sessionId);
                    }
                } else {
                    log('info', 'Session already being processed, requeuing message', { sessionId });
                    channel.nack(msg, false, true);
                }
            } catch (error) {
                log('error', 'Error processing queue message', { error: error.message });
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        log('error', 'Error setting up consumer', { error: error.message });
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
        
        const response = await client.chat.completions.create({
            model: "deepseek-chat",
            messages: sessionContext
        });

        const assistantMessage = {
            role: response.choices[0].message.role,
            content: response.choices[0].message.content
        };
        
        log('info', 'Received AI response', { 
            sessionId,
            messageLength: assistantMessage.content.length 
        });
        
        sessionContext.push(assistantMessage);
        
        if (sessionContext.length > 10) {
            sessionContext = sessionContext.slice(-10);
        }
        
        activeSessions.set(sessionId, sessionContext);
        return assistantMessage;
    } catch (error) {
        log('error', 'Error processing message', { error: error.message });
        throw error;
    }
}

app.post('/.netlify/functions/app', async (req, res) => {
    try {
        const { query: userInput, sessionId } = req.body;

        if (!userInput || !sessionId) {
            return res.status(400).json({ error: 'Query and sessionId are required' });
        }

        // Ensure RabbitMQ connection is available
        if (!channel) {
            log('info', 'Reconnecting to RabbitMQ');
            await connectQueue();
        }

        if (!channel) {
            throw new Error('Failed to establish RabbitMQ connection');
        }

        log('info', 'Sending message to queue', { sessionId });
        await channel.sendToQueue(
            QUEUE_NAME,
            Buffer.from(JSON.stringify({ userInput, sessionId })),
            { persistent: true }
        );

        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Request timeout'));
            }, 30000);

            io.once(`response_${sessionId}`, (data) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        log('info', 'Sending response to client', { sessionId });
        res.json({
            response: result.response,
            message_limit_reached: false
        });
    } catch (error) {
        log('error', 'Error handling request', { error: error.message });
        res.status(500).json({
            error: 'An error occurred while processing your request',
            details: error.message
        });
    }
});

// Initialize RabbitMQ connection
connectQueue().catch(error => {
    log('error', 'Failed to initialize RabbitMQ', { error: error.message });
});

// Export the serverless handler
exports.handler = serverless(app);