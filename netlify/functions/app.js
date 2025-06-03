const { OpenAI } = require('openai');
const express = require('express');
const serverless = require('serverless-http');

const app = express();

// Enhanced logging function with more detail
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const requestId = Math.random().toString(36).substring(7);
    console[level](`[${timestamp}][${requestId}] ${message}`, {
        ...data,
        timestamp,
        requestId,
        environment: process.env.NODE_ENV
    });
}

// Log middleware for all requests
app.use((req, res, next) => {
    const start = Date.now();
    log('info', 'Incoming request', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body
    });

    res.on('finish', () => {
        const duration = Date.now() - start;
        log('info', 'Request completed', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration: `${duration}ms`
        });
    });

    next();
});

app.use(express.json());

app.post('/.netlify/functions/app', async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    log('info', 'Processing chat request', { requestId });

    try {
        const { query: userInput } = req.body;

        if (!userInput) {
            log('warn', 'Empty query received', { requestId });
            return res.status(400).json({ error: 'Query is required' });
        }

        log('info', 'Validating request parameters', {
            requestId,
            inputLength: userInput.length,
            inputPreview: userInput.substring(0, 50) + '...'
        });

        if (!process.env.OPENAI_API_KEY) {
            log('error', 'API key not configured', { requestId });
            return res.status(500).json({ error: 'API configuration error' });
        }

        log('info', 'Initializing AI client', { requestId });
        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: 'https://api.deepseek.com/v1'
        });

        log('info', 'Sending request to AI service', {
            requestId,
            model: "deepseek-chat"
        });

        const startTime = Date.now();
        const response = await client.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "user", content: userInput }]
        });
        const duration = Date.now() - startTime;

        const assistantMessage = {
            role: response.choices[0].message.role,
            content: response.choices[0].message.content
        };
        
        log('info', 'Received AI response', { 
            requestId,
            messageLength: assistantMessage.content.length,
            processingTime: `${duration}ms`,
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens
        });

        res.json({
            response: assistantMessage.content,
            message_limit_reached: false
        });

        log('info', 'Response sent to client', { requestId });
    } catch (error) {
        log('error', 'Error processing request', {
            requestId,
            error: error.message,
            stack: error.stack,
            type: error.constructor.name
        });

        res.status(500).json({
            error: 'An error occurred while processing your request',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/.netlify/functions/app/health', (req, res) => {
    log('info', 'Health check requested');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

log('info', 'Initializing serverless function');
exports.handler = serverless(app);