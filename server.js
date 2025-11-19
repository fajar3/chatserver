require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const callRoutes = require('./routes/callRoutes');
const socketHandler = require('./socket/socketHandler');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', authRoutes);
app.use('/api', chatRoutes);
app.use('/api', callRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Socket.IO handler
socketHandler(io);

const PORT = process.env.PORT || 3004;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
