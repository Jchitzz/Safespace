// server/index.js
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const matching = require('./matching');
const moderation = require('./moderation');

const app = express();
app.set('trust proxy', 1); // required on Railway/Render/etc. so rate limiting reads the real client IP
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // tighten origin in production

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const REPORTS_FILE = path.join(DATA_DIR, 'reports.log');

app.use(helmet());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Basic HTTP rate limiting (protects health/report endpoints from abuse).
const httpLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(httpLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// -------- Per-socket chat rate limiting (simple token bucket) --------
const MESSAGE_LIMIT = 6; // messages
const MESSAGE_WINDOW_MS = 5000; // per 5 seconds
const messageBuckets = new Map(); // socketId -> [timestamps]

function isRateLimited(socketId) {
  const now = Date.now();
  const bucket = (messageBuckets.get(socketId) || []).filter((t) => now - t < MESSAGE_WINDOW_MS);
  bucket.push(now);
  messageBuckets.set(socketId, bucket);
  return bucket.length > MESSAGE_LIMIT;
}

// -------- Session auto-timeout (avoid orphaned "active" sessions) --------
const MAX_SESSION_MS = 60 * 60 * 1000; // 1 hour hard cap

function broadcastQueueCounts() {
  io.emit('queue_counts', matching.getQueueCounts());
}

io.on('connection', (socket) => {
  const anonId = uuidv4(); // never tied to any account, email, or IP in storage
  const anonName = matching.generateUsername(); // fun display name, e.g. "Quiet Fox"

  socket.emit('queue_counts', matching.getQueueCounts());

  socket.on('join_queue', ({ role }) => {
    if (role !== 'venter' && role !== 'listener' && role !== 'flexible') return;
    const result = matching.joinQueue(role, socket.id, anonId, anonName);
    if (result.matched) {
      const partnerSocket = io.sockets.sockets.get(result.partnerSocketId);
      socket.join(result.sessionId);
      if (partnerSocket) partnerSocket.join(result.sessionId);

      socket.emit('matched', { sessionId: result.sessionId, role: result.assignedRole, myName: anonName, partnerName: result.partnerName });
      if (partnerSocket) {
        const partnerUser = matching.getUserBySocket(result.partnerSocketId);
        partnerSocket.emit('matched', { sessionId: result.sessionId, role: partnerUser.role, myName: partnerUser.name, partnerName: anonName });
      }

      setTimeout(() => {
        const session = matching.getSession(result.sessionId);
        if (session && session.status === 'active') {
          matching.endSession(result.sessionId);
          io.to(result.sessionId).emit('session_ended', { sessionId: result.sessionId, reason: 'timeout' });
        }
      }, MAX_SESSION_MS);
    } else {
      socket.emit('waiting');
    }
    broadcastQueueCounts();
  });

  socket.on('leave_queue', () => {
    matching.leaveQueue(socket.id);
    broadcastQueueCounts();
  });

  socket.on('send_message', ({ sessionId, text }) => {
    const user = matching.getUserBySocket(socket.id);
    if (!user || user.sessionId !== sessionId) return;
    const session = matching.getSession(sessionId);
    if (!session || session.status !== 'active') return;
    if (isRateLimited(socket.id)) {
      socket.emit('rate_limited');
      return;
    }
    if (!text || typeof text !== 'string' || !text.trim()) return;

    const clean = moderation.sanitizeMessage(text.trim());
    const crisisFlag = user.role === 'venter' && moderation.containsCrisisLanguage(clean);

    io.to(sessionId).emit('message', {
      sender: user.role,
      senderName: user.name,
      text: clean,
      ts: Date.now(),
    });

    if (crisisFlag) {
      socket.emit('crisis_resources', { message: moderation.CRISIS_RESOURCE_MESSAGE });
    }
  });

  socket.on('typing', ({ sessionId }) => {
    const user = matching.getUserBySocket(socket.id);
    if (!user || user.sessionId !== sessionId) return;
    const session = matching.getSession(sessionId);
    if (!session || session.status !== 'active') return;
    socket.to(sessionId).emit('partner_typing');
  });

  socket.on('stop_typing', ({ sessionId }) => {
    const user = matching.getUserBySocket(socket.id);
    if (!user || user.sessionId !== sessionId) return;
    socket.to(sessionId).emit('partner_stopped_typing');
  });

  socket.on('end_session', ({ sessionId }) => {
    const session = matching.endSession(sessionId);
    if (session) io.to(sessionId).emit('session_ended', { sessionId, reason: 'ended_by_peer' });
  });

  socket.on('report', ({ sessionId, reason, details }) => {
    const user = matching.getUserBySocket(socket.id);
    const entry = {
      id: uuidv4(),
      sessionId,
      reporterRole: user ? user.role : null,
      reason,
      details: (details || '').slice(0, 1000),
      ts: new Date().toISOString(),
    };
    fs.appendFile(REPORTS_FILE, JSON.stringify(entry) + '\n', (err) => {
      if (err) console.error('Failed to write report:', err);
    });
    socket.emit('report_received');
  });

  socket.on('disconnect', () => {
    const user = matching.disconnectSocket(socket.id);
    messageBuckets.delete(socket.id);
    if (user && user.sessionId) {
      const session = matching.endSession(user.sessionId);
      if (session) {
        socket.to(user.sessionId).emit('session_ended', { sessionId: user.sessionId, reason: 'peer_disconnected' });
      }
    }
    broadcastQueueCounts();
  });
});

// Periodic fallback so counts stay accurate even if someone's tab silently
// closed without a clean disconnect event, or a queue entry went stale.
setInterval(broadcastQueueCounts, 10000);

server.listen(PORT, () => {
  console.log(`safespace server listening on port ${PORT}`);
});
