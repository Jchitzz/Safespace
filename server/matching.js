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

const queues = { venter: [], listener: [], flexible: [] };
const sessions = new Map(); // sessionId -> { listenerId, venterId, startedAt, status }
const socketToUser = new Map(); // socketId -> { anonId, role, sessionId }

const STALE_MS = 3 * 60 * 1000;

function cleanQueue(role) {
  queues[role] = queues[role].filter((u) => Date.now() - u.joinedAt < STALE_MS);
}

function cleanAllQueues() {
  cleanQueue('venter');
  cleanQueue('listener');
  cleanQueue('flexible');
}

function getQueueCounts() {
  cleanAllQueues();
  return { venter: queues.venter.length, listener: queues.listener.length, flexible: queues.flexible.length };
}

function finalizeMatch(self, selfRole, partner, partnerRole) {
  const sessionId = uuidv4();
  const session = {
    startedAt: Date.now(),
    status: 'active',
    [selfRole]: self,
    [partnerRole]: partner,
  };
  sessions.set(sessionId, session);
  socketToUser.set(self.socketId, { anonId: self.anonId, name: self.name, role: selfRole, sessionId });
  socketToUser.set(partner.socketId, { anonId: partner.anonId, name: partner.name, role: partnerRole, sessionId });
  return { matched: true, sessionId, partnerSocketId: partner.socketId, partnerName: partner.name, assignedRole: selfRole };
}

// role is 'venter', 'listener', or 'flexible' (no preference — match with whoever's around).
function joinQueue(role, socketId, anonId, name) {
  cleanAllQueues();
  const self = { socketId, anonId, name };

  if (role === 'venter' || role === 'listener') {
    const opposite = role === 'venter' ? 'listener' : 'venter';
    if (queues[opposite].length > 0) {
      const partner = queues[opposite].shift();
      return finalizeMatch(self, role, partner, opposite);
    }
    if (queues.flexible.length > 0) {
      const partner = queues.flexible.shift();
      return finalizeMatch(self, role, partner, opposite);
    }
    queues[role].push({ ...self, joinedAt: Date.now() });
    return { matched: false };
  }

  // role === 'flexible': take whichever role is actually needed right now.
  if (queues.venter.length > 0) {
    const partner = queues.venter.shift();
    return finalizeMatch(self, 'listener', partner, 'venter');
  }
  if (queues.listener.length > 0) {
    const partner = queues.listener.shift();
    return finalizeMatch(self, 'venter', partner, 'listener');
  }
  if (queues.flexible.length > 0) {
    const partner = queues.flexible.shift();
    return finalizeMatch(self, 'listener', partner, 'venter'); // arbitrary but consistent split
  }
  queues.flexible.push({ ...self, joinedAt: Date.now() });
  return { matched: false };
}

function leaveQueue(socketId) {
  queues.venter = queues.venter.filter((u) => u.socketId !== socketId);
  queues.listener = queues.listener.filter((u) => u.socketId !== socketId);
  queues.flexible = queues.flexible.filter((u) => u.socketId !== socketId);
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
  getQueueCounts,
};
