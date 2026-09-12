// server/matching.js
//
// In-memory matching queue and session registry.
//
// NOTE ON SCALING: this is a single-process implementation, fine for one
// server instance or local dev. If you deploy multiple instances behind a
// load balancer, replace the Maps/arrays below with Redis (e.g. a Redis
// list for each queue and a Redis hash for sessions), since matching must
// be coordinated across processes.

const { v4: uuidv4 } = require('uuid');

// Fun, calm-toned anonymous display names — no identity, just personality.
const ADJECTIVES = [
  'Quiet', 'Gentle', 'Calm', 'Warm', 'Steady', 'Soft', 'Kind', 'Bright',
  'Hidden', 'Patient', 'Wandering', 'Sleepy', 'Curious', 'Brave', 'Mellow',
  'Drifting', 'Whispering', 'Peaceful', 'Humble', 'Quietly',
];
const NOUNS = [
  'Fox', 'River', 'Owl', 'Willow', 'Harbor', 'Ember', 'Meadow', 'Comet',
  'Lantern', 'Wave', 'Sparrow', 'Cedar', 'Horizon', 'Pebble', 'Cloud', 'Fern',
];

function generateUsername() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

const queues = { venter: [], listener: [] };
const sessions = new Map(); // sessionId -> { listenerId, venterId, startedAt, status }
const socketToUser = new Map(); // socketId -> { anonId, role, sessionId }

const STALE_MS = 3 * 60 * 1000;

function cleanQueue(role) {
  queues[role] = queues[role].filter((u) => Date.now() - u.joinedAt < STALE_MS);
}

function joinQueue(role, socketId, anonId, name) {
  const opposite = role === 'venter' ? 'listener' : 'venter';
  cleanQueue(opposite);
  cleanQueue(role);

  if (queues[opposite].length > 0) {
    const partner = queues[opposite].shift();
    const sessionId = uuidv4();
    const session = {
      startedAt: Date.now(),
      status: 'active',
      [role]: { socketId, anonId, name },
      [opposite]: partner,
    };
    sessions.set(sessionId, session);
    socketToUser.set(socketId, { anonId, name, role, sessionId });
    socketToUser.set(partner.socketId, { anonId: partner.anonId, name: partner.name, role: opposite, sessionId });
    return { matched: true, sessionId, partnerSocketId: partner.socketId, partnerName: partner.name };
  }

  queues[role].push({ socketId, anonId, name, joinedAt: Date.now() });
  return { matched: false };
}

function leaveQueue(socketId) {
  queues.venter = queues.venter.filter((u) => u.socketId !== socketId);
  queues.listener = queues.listener.filter((u) => u.socketId !== socketId);
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.status = 'ended';
  return session;
}

function getUserBySocket(socketId) {
  return socketToUser.get(socketId);
}

function disconnectSocket(socketId) {
  leaveQueue(socketId);
  const user = socketToUser.get(socketId);
  socketToUser.delete(socketId);
  return user;
}

module.exports = {
  generateUsername,
  joinQueue,
  leaveQueue,
  getSession,
  endSession,
  getUserBySocket,
  disconnectSocket,
};
