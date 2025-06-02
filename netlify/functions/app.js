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
            log('info', 'Queue already exists, using existing queue');
        } catch (error) {
            log('info', 'Queue does not exist, creating new queue');
            await channel.assertQueue(QUEUE_NAME, {
                durable: true,
                arguments: {
                    'x-message-ttl': 60000,
                    'x-max-length': 1000,
                    'x-overflow': 'reject-publish',
                    'x-queue-mode': 'lazy'
                }
            });
        }

        await channel.prefetch(1);
        await setupQueueConsumer();

        // Handle connection closure
        connection.on('close', async (err) => {
            log('warn', 'RabbitMQ connection closed', { error: err?.message });
            channel = null;
            connection = null;
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
                        } finally {
                            processingQueue.delete(sessionId);
                        }
                    } else {
                        channel.nack(msg, false, true);
                    }
                } catch (error) {
                    log('error', 'Error processing message', { error: error.message });
                    channel.nack(msg, false, false);
                }
            }
        });
    } catch (error) {
        log('error', 'Error setting up consumer', { error: error.message });
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