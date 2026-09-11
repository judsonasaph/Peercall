require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 1. Express rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(apiLimiter);

// ── Metered.ca TURN credential management ─────────────────────────────────
let _cachedIceServers = null;
let _iceCacheTime = 0;
const ICE_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// TURN fallback used when Metered.ca API key is not configured or fails
// Uses the public Open Relay project (rate-limited but free)
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  // Metered.ca Open Relay — a.relay.metered.ca is the current active hostname
  { urls: 'turn:a.relay.metered.ca:80',                   username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:80?transport=udp',     username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443',                  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp',    username: 'openrelayproject', credential: 'openrelayproject' },
  // Secondary: old hostname as extra fallback
  { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
];

async function fetchMeteredIceServers() {
  const apiKey = process.env.METERED_API_KEY;
  if (!apiKey) {
    console.log('[TURN] METERED_API_KEY not set — using open-relay fallback');
    return null;
  }

  // Try multiple URL patterns — the subdomain changes per Metered.ca app name
  const endpoints = [
    `https://peercall.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`,
    `https://global.metered.ca/api/v1/turn/credentials?apiKey=${apiKey}`,
  ];

  for (const url of endpoints) {
    try {
      console.log('[TURN] Trying:', url.replace(apiKey, '***'));
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(5000), // 5s timeout per endpoint
      });
      if (!resp.ok) {
        console.warn(`[TURN] ${url.split('/')[2]} returned HTTP ${resp.status}`);
        continue;
      }
      const servers = await resp.json();
      if (Array.isArray(servers) && servers.length > 0) {
        console.log(`[TURN] ✓ Got ${servers.length} authenticated TURN servers from ${url.split('/')[2]}`);
        return servers;
      }
    } catch (err) {
      console.warn(`[TURN] Failed ${url.split('/')[2]}:`, err.message);
    }
  }
  return null;
}

async function getIceServers() {
  const now = Date.now();
  if (_cachedIceServers && (now - _iceCacheTime) < ICE_CACHE_TTL) {
    return _cachedIceServers;
  }

  // Try authenticated Metered.ca TURN first
  const metered = await fetchMeteredIceServers();
  if (metered && metered.length > 0) {
    _cachedIceServers = metered;
    _iceCacheTime = now;
    return _cachedIceServers;
  }

  // Build fallback list
  const servers = [...FALLBACK_ICE_SERVERS];

  // Also allow manual TURN override via env vars
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  console.log(`[TURN] Using ${servers.length}-server fallback (${servers.filter(s => s.urls.startsWith('turn:')).length} TURN entries)`);
  return servers;
}

// Pre-warm cache at startup so first call is instant
getIceServers().then(s => {
  const turnCount = s.filter(x => x.urls && x.urls.startsWith('turn:')).length;
  console.log(`[TURN] Cache warmed: ${s.length} total, ${turnCount} TURN servers`);
});
// Refresh every 12 hours
setInterval(() => {
  _cachedIceServers = null;
  getIceServers().then(s => console.log(`[TURN] Cache refreshed: ${s.length} servers`));
}, ICE_CACHE_TTL);

// ICE Config Endpoint
app.get('/api/ice-config', async (req, res) => {
  try {
    const iceServers = await getIceServers();
    res.json({ iceServers });
  } catch (err) {
    console.error('[ICE Config] Error:', err);
    // Even on error, return usable fallback
    res.json({ iceServers: FALLBACK_ICE_SERVERS });
  }
});


// 3. In-memory room store
const rooms = new Map();

function findRoomBySocket(socketId) {
  for (const [code, room] of rooms.entries()) {
    if (room.creatorSocketId === socketId || room.joinerSocketId === socketId) {
      return room;
    }
  }
  return null;
}

// 4. Code generation
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  for (let i = 0; i < 5; i++) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let j = 0; j < 6; j++) {
      code += CHARSET[bytes[j] % CHARSET.length];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error('Failed to generate a unique room code after 5 attempts');
}

// 5. Rate limiting for join attempts
const joinAttempts = new Map();

function checkJoinRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxAttempts = 5;

  let attemptData = joinAttempts.get(ip);
  if (!attemptData) {
    attemptData = { count: 1, firstAttempt: now };
    joinAttempts.set(ip, attemptData);
    return true; // Allowed
  }

  if (now - attemptData.firstAttempt > windowMs) {
    // Reset window
    attemptData.count = 1;
    attemptData.firstAttempt = now;
    return true; // Allowed
  }

  attemptData.count++;
  if (attemptData.count > maxAttempts) {
    return false; // Rate limited
  }

  return true; // Allowed
}

// Periodically clean up join attempts map
setInterval(() => {
  const now = Date.now();
  const windowMs = 60 * 1000;
  for (const [ip, data] of joinAttempts.entries()) {
    if (now - data.firstAttempt > windowMs) {
      joinAttempts.delete(ip);
    }
  }
}, 60 * 1000);

// 6. Room auto-expiry
setInterval(() => {
  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  
  for (const [code, room] of rooms.entries()) {
    if (room.state === 'waiting' && (now - room.createdAt) > TEN_MINUTES) {
      console.log(`[Expiry] Auto-expiring waiting room ${code}`);
      destroyRoom(code);
    }
  }
}, 60 * 1000); // Check every 60 seconds

// Helper function: destroyRoom
function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  
  console.log(`[Destroy] Destroying room ${code}`);
  
  if (room.joinTimeoutId) {
    clearTimeout(room.joinTimeoutId);
  }
  
  if (room.creatorSocketId) {
    const creatorSocket = io.sockets.sockets.get(room.creatorSocketId);
    if (creatorSocket) creatorSocket.leave(code);
  }
  
  if (room.joinerSocketId) {
    const joinerSocket = io.sockets.sockets.get(room.joinerSocketId);
    if (joinerSocket) joinerSocket.leave(code);
  }
  
  rooms.delete(code);
}

// 7. Socket.io Event Handlers
io.on('connection', (socket) => {
  console.log(`[Connection] Socket connected: ${socket.id}`);
  
  // Get IP address for rate limiting
  const ip = socket.handshake.address;

  socket.on('create-room', () => {
    try {
      const code = generateRoomCode();
      const room = {
        code,
        creatorSocketId: socket.id,
        joinerSocketId: null,
        createdAt: Date.now(),
        state: 'waiting',
        joinTimeoutId: null
      };
      
      rooms.set(code, room);
      socket.join(code);
      
      console.log(`[Room Created] Code: ${code} by ${socket.id}`);
      socket.emit('room-created', { code });
    } catch (err) {
      console.error('[Error] creating room:', err);
      socket.emit('error', { message: 'Could not create room' });
    }
  });

  socket.on('join-request', ({ code }) => {
    if (!code || typeof code !== 'string') return;
    code = code.toUpperCase();

    // 5. Rate limit check
    if (!checkJoinRateLimit(ip)) {
      console.log(`[Rate Limit] Join request blocked for IP ${ip}`);
      return socket.emit('join-error', { message: 'Too many join attempts. Please wait a minute.' });
    }

    // Format validation
    const codeRegex = new RegExp(`^[${CHARSET}]{6}$`);
    if (!codeRegex.test(code)) {
      return socket.emit('join-error', { message: 'Invalid room code format' });
    }

    const room = rooms.get(code);
    if (!room) {
      return socket.emit('join-error', { message: 'Room not found' });
    }

    if (room.state !== 'waiting') {
      return socket.emit('join-error', { message: 'Room is not available' });
    }

    console.log(`[Join Request] ${socket.id} requesting to join ${code}`);
    
    room.state = 'pending';
    room.joinerSocketId = socket.id;

    // Emit to creator
    const creatorSocket = io.sockets.sockets.get(room.creatorSocketId);
    if (creatorSocket) {
      creatorSocket.emit('join-request', { socketId: socket.id });
    } else {
      // Creator gone?
      destroyRoom(code);
      return socket.emit('join-error', { message: 'Room creator disconnected' });
    }

    // Timeout if no response
    room.joinTimeoutId = setTimeout(() => {
      console.log(`[Join Timeout] Join request to ${code} timed out`);
      socket.emit('join-timeout');
      
      if (rooms.has(code)) {
        const r = rooms.get(code);
        r.state = 'waiting';
        r.joinerSocketId = null;
        r.joinTimeoutId = null;
      }
    }, 30000);
  });

  socket.on('join-response', ({ approved }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.creatorSocketId !== socket.id || room.state !== 'pending') return;

    if (room.joinTimeoutId) {
      clearTimeout(room.joinTimeoutId);
      room.joinTimeoutId = null;
    }

    const joinerSocket = io.sockets.sockets.get(room.joinerSocketId);
    
    if (approved) {
      console.log(`[Join Approved] Room ${room.code} active`);
      room.state = 'active';
      if (joinerSocket) {
        joinerSocket.join(room.code);
        io.to(room.code).emit('join-approved');
      } else {
        // Joiner disconnected while pending
        room.state = 'waiting';
        room.joinerSocketId = null;
      }
    } else {
      console.log(`[Join Denied] Room ${room.code} denied`);
      room.state = 'waiting';
      room.joinerSocketId = null;
      
      if (joinerSocket) {
        joinerSocket.emit('join-denied');
      }
    }
  });

  socket.on('webrtc-offer', ({ sdp }) => {
    const room = findRoomBySocket(socket.id);
    if (room && room.state === 'active') {
      const otherId = socket.id === room.creatorSocketId ? room.joinerSocketId : room.creatorSocketId;
      socket.to(otherId).emit('webrtc-offer', { sdp });
    }
  });

  socket.on('webrtc-answer', ({ sdp }) => {
    const room = findRoomBySocket(socket.id);
    if (room && room.state === 'active') {
      const otherId = socket.id === room.creatorSocketId ? room.joinerSocketId : room.creatorSocketId;
      socket.to(otherId).emit('webrtc-answer', { sdp });
    }
  });

  socket.on('ice-candidate', ({ candidate }) => {
    const room = findRoomBySocket(socket.id);
    if (room && room.state === 'active') {
      const otherId = socket.id === room.creatorSocketId ? room.joinerSocketId : room.creatorSocketId;
      socket.to(otherId).emit('ice-candidate', { candidate });
    }
  });

  socket.on('leave-room', () => {
    const room = findRoomBySocket(socket.id);
    if (room) {
      console.log(`[Leave Room] ${socket.id} left room ${room.code}`);
      const otherId = socket.id === room.creatorSocketId ? room.joinerSocketId : room.creatorSocketId;
      if (otherId) {
        socket.to(otherId).emit('peer-left');
      }
      destroyRoom(room.code);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Disconnect] Socket disconnected: ${socket.id}`);
    const room = findRoomBySocket(socket.id);
    if (room) {
      const otherId = socket.id === room.creatorSocketId ? room.joinerSocketId : room.creatorSocketId;
      if (otherId) {
        socket.to(otherId).emit('peer-left');
      }
      destroyRoom(room.code);
    }
  });
});

// 8. Server listen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
