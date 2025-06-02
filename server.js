const express = require('express');
const { OpenAI } = require('openai');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Active sessions storage
const activeSessions = new Map();

// Middleware
app.use(express.json());
app.use(express.static('static'));

// Socket.IO setup
const server = require('http').createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/query', async (req, res) => {
  const { query: userInput, sessionId } = req.body;

  if (!userInput || !sessionId) {
    return res.status(400).json({ error: 'Query and sessionId are required' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // Initialize or get session messages
    if (!activeSessions.has(sessionId)) {
      activeSessions.set(sessionId, []);
    }

    const sessionMessages = activeSessions.get(sessionId);
    const userMessage = { role: "user", content: userInput };
    sessionMessages.push(userMessage);

    const client = new OpenAI({
      apiKey: apiKey,
      baseURL: 'https://api.deepseek.com/v1'
    });

    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: sessionMessages
    });

    const assistantMessage = {
      role: response.choices[0].message.role,
      content: response.choices[0].message.content
    };

    sessionMessages.push(assistantMessage);

    let messageLimitReached = false;
    if (sessionMessages.length > 10) {
      activeSessions.set(sessionId, sessionMessages.slice(-10));
      messageLimitReached = true;
    }

    // Emit updated sessions to admin panel
    io.emit('sessions', Array.from(activeSessions.entries()));

    res.json({
      response: assistantMessage.content,
      message_limit_reached: messageLimitReached
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO event handlers
io.on('connection', (socket) => {
  socket.emit('sessions', Array.from(activeSessions.entries()));

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

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});