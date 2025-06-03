const { OpenAI } = require('openai');
const express = require('express');
const serverless = require('serverless-http');

const app = express();

// Enhanced logging function
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] ${message}`, data);
}

app.use(express.json());

app.post('/.netlify/functions/app', async (req, res) => {
    try {
        const { query: userInput } = req.body;

        if (!userInput) {
            return res.status(400).json({ error: 'Query is required' });
        }

        log('info', 'Processing request', { userInput: userInput.substring(0, 50) + '...' });

        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: 'https://api.deepseek.com/v1'
        });

        log('info', 'Sending request to AI service');
        const response = await client.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "user", content: userInput }]
        });

        const assistantMessage = {
            role: response.choices[0].message.role,
            content: response.choices[0].message.content
        };
        
        log('info', 'Received AI response', { 
            messageLength: assistantMessage.content.length 
        });

        res.json({
            response: assistantMessage.content,
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

// Export the serverless handler
exports.handler = serverless(app);