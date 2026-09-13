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
const notes = require('./notes');
const bans = require('./bans');
const proxyCheck = require('./proxyCheck');

const app = express();
app.set('trust proxy', 1); // required on Railway/Render/etc. so rate limiting reads the real client IP
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // tighten origin in production

// -------- Optional Redis adapter for running multiple server instances --------
// Only activates if REDIS_URL is set. Without it, Socket.IO rooms/broadcasts
// (and matching, via matching.js) only work correctly within a single
// process — fine for one Railway/Render instance, not for a scaled fleet.
if (process.env.REDIS_URL) {
  // eslint-disable-next-line global-require
  const { createAdapter } = require('@socket.io/redis-adapter');
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  const pubClient = new Redis(process.env.REDIS_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  console.log('Redis adapter enabled — safe to run multiple instances.');
} else {
  console.log('No REDIS_URL set — running in single-instance, in-memory mode.');
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const REPORTS_FILE = path.join(DATA_DIR, 'reports.log');

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // for the admin dashboard's plain HTML forms
app.use(express.static(path.join(__dirname, '..', 'public')));

// Basic HTTP rate limiting (protects health/report endpoints from abuse).
const httpLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(httpLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// -------- Admin reports dashboard (Basic Auth, gated by env var) --------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) {
    return res.status(503).send('Admin dashboard is disabled. Set ADMIN_PASSWORD in your environment to enable it.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === expectedUser && pass === expectedPass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SafeSpace Admin"');
  return res.status(401).send('Authentication required.');
}

app.get('/admin/reports', requireAdminAuth, (req, res) => {
  fs.readFile(REPORTS_FILE, 'utf8', (err, data) => {
    const lines = err ? [] : data.trim().split('\n').filter(Boolean);
    const entries = lines
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean)
      .reverse();
    const rows = entries.map((e) => `
      <tr>
        <td>${escapeHtml(e.ts || '')}</td>
        <td>${escapeHtml(e.reason || '')}</td>
        <td>${escapeHtml(e.reporterRole || '')}</td>
        <td>${escapeHtml((e.details || '').slice(0, 300))}</td>
        <td class="mono">${escapeHtml(e.sessionId || '')}</td>
        <td class="mono">${escapeHtml(e.reportedIp || '\u2014')}</td>
        <td>${e.reportedIp ? `
          <form method="POST" action="/admin/bans" class="inline-form">
            <input type="hidden" name="ip" value="${escapeHtml(e.reportedIp)}">
            <input type="hidden" name="reason" value="Manual ban from report dated ${escapeHtml(e.ts || '')}">
            <select name="days">
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="0">Permanent</option>
            </select>
            <button type="submit">Ban IP</button>
          </form>` : ''}
        </td>
      </tr>`).join('');
    res.send(`<!DOCTYPE html>
      <html><head><title>Reports — SafeSpace Admin</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #14161a; color: #ece8e0; padding: 32px; }
        h1 { font-weight: 500; }
        a { color: #a1a3a9; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border-bottom: 1px solid #33373f; padding: 10px 8px; text-align: left; font-size: 0.85rem; vertical-align: top; }
        th { color: #a1a3a9; font-weight: 600; }
        .mono { font-family: monospace; font-size: 0.75rem; color: #8b8d93; }
        .inline-form { display: flex; gap: 6px; align-items: center; }
        select, button { font-size: 0.78rem; background: #262a31; color: #ece8e0; border: 1px solid #33373f; border-radius: 6px; padding: 4px 6px; }
        button { cursor: pointer; }
        button:hover { background: #33373f; }
      </style></head>
      <body>
        <p><a href="/admin/bans">View / manage banned IPs \u2192</a></p>
        <h1>Reports (${entries.length})</h1>
        <table>
          <tr><th>Time</th><th>Reason</th><th>Reporter role</th><th>Details</th><th>Session</th><th>Reported IP</th><th>Action</th></tr>
          ${rows || '<tr><td colspan="7">No reports yet.</td></tr>'}
        </table>
      </body></html>`);
  });
});

app.post('/admin/bans', requireAdminAuth, async (req, res) => {
  const { ip, reason, days } = req.body || {};
  if (!ip) return res.status(400).send('Missing IP.');
  const durationMs = days && Number(days) > 0 ? Number(days) * 24 * 60 * 60 * 1000 : null;
  await bans.banIp(ip, reason || 'Manually banned via admin dashboard', durationMs);
  res.redirect('/admin/bans');
});

app.post('/admin/bans/unban', requireAdminAuth, async (req, res) => {
  const { ip } = req.body || {};
  if (ip) await bans.unbanIp(ip);
  res.redirect('/admin/bans');
});

app.get('/admin/bans', requireAdminAuth, async (req, res) => {
  const list = await bans.listBans();
  const rows = list.map((b) => `
    <tr>
      <td class="mono">${escapeHtml(b.ip)}</td>
      <td>${escapeHtml(b.reason || '')}</td>
      <td>${escapeHtml(new Date(b.bannedAt).toISOString())}</td>
      <td>${b.expiresAt ? escapeHtml(new Date(b.expiresAt).toISOString()) : 'Permanent'}</td>
      <td>
        <form method="POST" action="/admin/bans/unban" class="inline-form">
          <input type="hidden" name="ip" value="${escapeHtml(b.ip)}">
          <button type="submit">Unban</button>
        </form>
      </td>
    </tr>`).join('');
  res.send(`<!DOCTYPE html>
    <html><head><title>Banned IPs — SafeSpace Admin</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #14161a; color: #ece8e0; padding: 32px; }
      h1 { font-weight: 500; }
      a { color: #a1a3a9; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { border-bottom: 1px solid #33373f; padding: 10px 8px; text-align: left; font-size: 0.85rem; vertical-align: top; }
      th { color: #a1a3a9; font-weight: 600; }
      .mono { font-family: monospace; font-size: 0.8rem; color: #8b8d93; }
      form.manual { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
      input, select, button { font-size: 0.85rem; background: #262a31; color: #ece8e0; border: 1px solid #33373f; border-radius: 6px; padding: 6px 10px; }
      button { cursor: pointer; }
      button:hover { background: #33373f; }
      .inline-form { display: flex; }
    </style></head>
    <body>
      <p><a href="/admin/reports">\u2190 Back to reports</a></p>
      <h1>Banned IPs (${list.length})</h1>
      <table>
        <tr><th>IP</th><th>Reason</th><th>Banned at</th><th>Expires</th><th></th></tr>
        ${rows || '<tr><td colspan="5">No active bans.</td></tr>'}
      </table>
      <h2 style="font-weight:500;margin-top:32px;">Manually ban an IP</h2>
      <form class="manual" method="POST" action="/admin/bans">
        <input type="text" name="ip" placeholder="IP address" required>
        <input type="text" name="reason" placeholder="Reason (optional)">
        <select name="days">
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="0">Permanent</option>
        </select>
        <button type="submit">Ban</button>
      </form>
    </body></html>`);
});

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

// -------- Per-socket note-wall rate limiting --------
const NOTE_LIMIT = 3;
const NOTE_WINDOW_MS = 10 * 60 * 1000; // 3 notes per 10 minutes
const noteBuckets = new Map();

function isNoteRateLimited(socketId) {
  const now = Date.now();
  const bucket = (noteBuckets.get(socketId) || []).filter((t) => now - t < NOTE_WINDOW_MS);
  bucket.push(now);
  noteBuckets.set(socketId, bucket);
  return bucket.length > NOTE_LIMIT;
}

// -------- Session auto-timeout (avoid orphaned "active" sessions) --------
const MAX_SESSION_MS = 60 * 60 * 1000; // 1 hour hard cap

async function broadcastQueueCounts() {
  io.emit('queue_counts', await matching.getQueueCounts());
}

async function broadcastHomeStats() {
  const [conversationCount, communityNotes] = await Promise.all([
    matching.getConversationCount(),
    notes.getNotes(50),
  ]);
  io.emit('home_stats', { conversationCount, communityNotes });
}

// Applies a re-match cooldown between whichever two anonIds took part in a
// session, so an abrupt disconnect or a report doesn't lead to an instant
// rematch with the same person.
async function cooldownSessionParticipants(session) {
  if (!session) return;
  const venter = session.venter;
  const listener = session.listener;
  if (venter && listener) {
    await matching.applyCooldown(venter.anonId, listener.anonId);
  }
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

const BLOCK_VPN_TRAFFIC = process.env.BLOCK_VPN_TRAFFIC === 'true';

io.on('connection', async (socket) => {
  const anonId = uuidv4(); // a fresh, unlinkable identity per connection
  const anonName = matching.generateUsername(); // fun display name, e.g. "Quiet Fox"
  const clientIp = getClientIp(socket);

  // Banned IPs are cut off immediately, before they can join any queue.
  // Note: this is server-side only, used for abuse prevention — not
  // exposed to other users, and not the same as the ephemeral anonId shown
  // in the UI. See README for what this can and can't actually achieve.
  const existingBan = await bans.isBanned(clientIp);
  if (existingBan) {
    socket.emit('banned', { reason: existingBan.reason, expiresAt: existingBan.expiresAt });
    socket.disconnect(true);
    return;
  }

  if (BLOCK_VPN_TRAFFIC) {
    const proxyResult = await proxyCheck.isLikelyVpnOrProxy(clientIp);
    if (proxyResult.checked && proxyResult.isProxy) {
      socket.emit('banned', { reason: 'This site restricts VPN/proxy connections.', expiresAt: null });
      socket.disconnect(true);
      return;
    }
  }

  matching.getQueueCounts().then((counts) => socket.emit('queue_counts', counts));
  Promise.all([matching.getConversationCount(), notes.getNotes(50)]).then(([conversationCount, communityNotes]) => {
    socket.emit('home_stats', { conversationCount, communityNotes });
  });

  socket.on('join_queue', async ({ role }) => {
    if (role !== 'venter' && role !== 'listener' && role !== 'flexible') return;
    const result = await matching.joinQueue(role, socket.id, anonId, anonName, clientIp);
    if (result.matched) {
      // Room joins/emits go through io.in()/io.to() rather than direct
      // socket references, so this also works correctly across instances
      // when the Redis adapter is active (the partner's socket may live on
      // a different process).
      await io.in(socket.id).socketsJoin(result.sessionId);
      await io.in(result.partnerSocketId).socketsJoin(result.sessionId);

      socket.emit('matched', { sessionId: result.sessionId, role: result.assignedRole, myName: anonName, partnerName: result.partnerName });
      const partnerUser = await matching.getUserBySocket(result.partnerSocketId);
      if (partnerUser) {
        io.to(result.partnerSocketId).emit('matched', { sessionId: result.sessionId, role: partnerUser.role, myName: partnerUser.name, partnerName: anonName });
      }

      setTimeout(async () => {
        const session = await matching.getSession(result.sessionId);
        if (session && session.status === 'active') {
          await matching.endSession(result.sessionId);
          io.to(result.sessionId).emit('session_ended', { sessionId: result.sessionId, reason: 'timeout' });
        }
      }, MAX_SESSION_MS);

      broadcastHomeStats();
    } else {
      socket.emit('waiting');
    }
    await broadcastQueueCounts();
  });

  socket.on('leave_queue', async () => {
    await matching.leaveQueue(socket.id);
    await broadcastQueueCounts();
  });

  socket.on('send_message', async ({ sessionId, text }) => {
    const user = await matching.getUserBySocket(socket.id);
    if (!user || user.sessionId !== sessionId) return;
    const session = await matching.getSession(sessionId);
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

  socket.on('typing', async ({ sessionId }) => {
    const user = await matching.getUserBySocket(socket.id);
    if (!user || user.sessionId !== sessionId) return;
    const session = await matching.getSession(sessionId);
    if (!session || session.status !== 'active') return;
    socket.to(sessionId).emit('partner_typing');
  });

  socket.on('stop_typing', async ({ sessionId }) => {
    const user = await matching.getUserBySocket(socket.id);
    if (!user || user.sessionId !== sessionId) return;
    socket.to(sessionId).emit('partner_stopped_typing');
  });

  socket.on('end_session', async ({ sessionId }) => {
    const session = await matching.endSession(sessionId);
    if (session) io.to(sessionId).emit('session_ended', { sessionId, reason: 'ended_by_peer' });
  });

  socket.on('report', async ({ sessionId, reason, details }) => {
    const user = await matching.getUserBySocket(socket.id);
    const session = await matching.getSession(sessionId);
    let reportedIp = null;
    if (user && session) {
      const oppositeRole = user.role === 'venter' ? 'listener' : 'venter';
      if (session[oppositeRole]) reportedIp = session[oppositeRole].ip || null;
    }
    const entry = {
      id: uuidv4(),
      sessionId,
      reporterRole: user ? user.role : null,
      reason,
      details: (details || '').slice(0, 1000),
      reportedIp,
      ts: new Date().toISOString(),
    };
    fs.appendFile(REPORTS_FILE, `${JSON.stringify(entry)}\n`, (err) => {
      if (err) console.error('Failed to write report:', err);
    });

    await cooldownSessionParticipants(session);

    if (reportedIp) {
      const newBan = await bans.recordReportForIp(reportedIp);
      if (newBan) console.log(`Auto-banned IP ${reportedIp}: ${newBan.reason}`);
    }

    socket.emit('report_received');
  });

  socket.on('submit_note', async ({ text }) => {
    if (isNoteRateLimited(socket.id)) {
      socket.emit('note_rejected', { reason: 'rate_limited' });
      return;
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
      socket.emit('note_rejected', { reason: 'empty' });
      return;
    }
    if (trimmed.length > 140) {
      socket.emit('note_rejected', { reason: 'too_long' });
      return;
    }
    if (moderation.containsCrisisLanguage(trimmed)) {
      socket.emit('note_rejected', { reason: 'crisis', message: moderation.CRISIS_RESOURCE_MESSAGE });
      return;
    }
    const clean = moderation.sanitizeMessage(trimmed);
    await notes.addNote(clean);
    socket.emit('note_accepted');
    await broadcastHomeStats();
  });

  socket.on('disconnect', async () => {
    const user = await matching.disconnectSocket(socket.id);
    messageBuckets.delete(socket.id);
    noteBuckets.delete(socket.id);
    if (user && user.sessionId) {
      const session = await matching.endSession(user.sessionId);
      if (session) {
        socket.to(user.sessionId).emit('session_ended', { sessionId: user.sessionId, reason: 'peer_disconnected' });
        await cooldownSessionParticipants(session); // abrupt ending — cool down this pair
      }
    }
    await broadcastQueueCounts();
  });
});

// Periodic fallback so counts/stats stay accurate even if someone's tab
// silently closed without a clean disconnect event, a queue entry went
// stale, or (in Redis mode) another instance changed shared state.
setInterval(broadcastQueueCounts, 10000);
setInterval(broadcastHomeStats, 15000);

server.listen(PORT, () => {
  console.log(`safespace server listening on port ${PORT}`);
});
