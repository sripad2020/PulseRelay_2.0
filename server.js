const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state for LAN live connections
// Room schema: { [roomId]: { [socketId]: { id, alias, avatar, color, joinedAt } } }
const rooms = {};

// Helper to get local IPv4 address
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses.length > 0 ? addresses : ['127.0.0.1'];
}

// REST fallback API for Vercel / LAN discovery
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), lanIps: getLocalIpAddresses() });
});

app.post('/api/signal', (req, res) => {
  const signalHandler = require('./api/signal');
  return signalHandler(req, res);
});

// Socket.IO signaling & messaging
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  socket.on('join-room', ({ roomId, user }) => {
    if (!roomId || !user) return;

    // Leave previous room if any
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][socket.id];
      socket.leave(currentRoom);
      io.to(currentRoom).emit('user-left', { socketId: socket.id, user: currentUser });
    }

    currentRoom = roomId;
    currentUser = { ...user, socketId: socket.id };
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {};
    }
    rooms[roomId][socket.id] = currentUser;

    const roomUsers = Object.values(rooms[roomId]);

    // Notify room of new participant
    io.to(roomId).emit('room-users', { roomId, users: roomUsers });
    socket.to(roomId).emit('user-joined', { socketId: socket.id, user: currentUser });

    console.log(`[+] User ${currentUser.alias} (${socket.id}) joined room: ${roomId}`);
  });

  // Relay chat message to room peers
  socket.on('chat-message', (msgData) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('chat-message', msgData);
  });

  // Relay typing indicator
  socket.on('typing-status', (typingData) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('typing-status', typingData);
  });

  // WebRTC P2P Signaling (Offer/Answer/Candidate)
  socket.on('webrtc-signal', (data) => {
    const { targetSocketId, signal, sender } = data;
    if (targetSocketId) {
      // Direct peer signal relay
      io.to(targetSocketId).emit('webrtc-signal', {
        senderSocketId: socket.id,
        signal,
        sender
      });
    } else if (currentRoom) {
      // Broadcast signal to room except sender
      socket.to(currentRoom).emit('webrtc-signal', {
        senderSocketId: socket.id,
        signal,
        sender
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const leavingUser = rooms[currentRoom][socket.id];
      delete rooms[currentRoom][socket.id];
      
      if (Object.keys(rooms[currentRoom]).length === 0) {
        delete rooms[currentRoom];
      } else {
        io.to(currentRoom).emit('user-left', { socketId: socket.id, user: leavingUser });
        io.to(currentRoom).emit('room-users', { roomId: currentRoom, users: Object.values(rooms[currentRoom]) });
      }
      console.log(`[-] User ${leavingUser?.alias || socket.id} left room: ${currentRoom}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLocalIpAddresses();
  console.log('\n======================================================');
  console.log('  🚀 Anonymous LAN & Vercel Chat Server Running!');
  console.log('======================================================');
  console.log(`  🏠 Local Access:   http://localhost:${PORT}`);
  lanIps.forEach((ip) => {
    console.log(`  🌐 LAN Access:     http://${ip}:${PORT}`);
  });
  console.log('------------------------------------------------------');
  console.log('  📱 Share the LAN URL with any device on your WiFi!');
  console.log('======================================================\n');
});
