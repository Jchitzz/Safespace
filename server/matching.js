// server/matching.js
//
// Matching queue, session registry, re-match cooldown, and conversation
// counter — with an optional Redis-backed store for running more than one
// server instance.
//
// MODE SELECTION: if process.env.REDIS_URL is set, all state (queues,
// sessions, per-socket user records, cooldowns, the conversation counter)
// lives in Redis so any instance behind a load balancer can match any two
// users. If REDIS_URL is unset, everything falls back to in-process Maps —
// fine for local dev or a single Railway/Render instance, but matching will
// NOT work correctly across multiple instances in that mode.
//
// CONCURRENCY NOTE: queue reads/filters/writes below are not wrapped in a
// distributed lock or Lua script. Under real concurrent load across
// multiple instances there's a small race window between reading a queue
// and removing the chosen candidate from it, which could in rare cases let
// two joiners both think they matched the same waiting candidate. For an
// app at this scale that's an acceptable, documented tradeoff; if you need
// airtight correctness under heavy concurrent traffic, move the
// pick-and-remove step into a single Redis Lua script (EVAL) instead.

const { v4: uuidv4 } = require('uuid');

const REDIS_URL = process.env.REDIS_URL;
let redis = null;
if (REDIS_URL) {
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  redis = new Redis(REDIS_URL);
  redis.on('error', (err) => console.error('Redis connection error:', err.message));
}

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

const STALE_MS = 3 * 60 * 1000; // stale queue entries are dropped after this
const COOLDOWN_MS = 30 * 60 * 1000; // two people who just had a bad ending won't be rematched for this long
const SESSION_TTL_SEC = 60 * 60 * 2; // Redis-only: expire stray session/user records after 2h

// ---------------- in-memory fallback store ----------------
const mem = {
  queues: { venter: [], listener: [], flexible: [] },
  sessions: new Map(),
  socketToUser: new Map(),
  cooldowns: new Map(), // "idA|idB" -> expiry timestamp
  conversationCount: 0,
};

function cooldownKey(idA, idB) {
  return [idA, idB].sort().join('|');
}

// ---------------- low-level store operations (dual backend) ----------------
async function queueRead(role) {
  if (redis) {
    const raw = await redis.lrange(`queue:${role}`, 0, -1);
    return raw.map((s) => JSON.parse(s));
  }
  return mem.queues[role];
}

async function queueWriteAll(role, arr) {
  if (redis) {
    const key = `queue:${role}`;
    const pipeline = redis.pipeline();
    pipeline.del(key);
    arr.forEach((u) => pipeline.rpush(key, JSON.stringify(u)));
    await pipeline.exec();
  } else {
    mem.queues[role] = arr;
  }
}

async function queuePush(role, entry) {
  if (redis) {
    await redis.rpush(`queue:${role}`, JSON.stringify(entry));
  } else {
    mem.queues[role].push(entry);
  }
}

async function isOnCooldown(idA, idB) {
  if (!idA || !idB) return false;
  const key = cooldownKey(idA, idB);
  if (redis) return !!(await redis.exists(`cooldown:${key}`));
  const expiry = mem.cooldowns.get(key);
  return !!expiry && Date.now() < expiry;
}

async function setCooldown(idA, idB) {
  if (!idA || !idB) return;
  const key = cooldownKey(idA, idB);
  if (redis) await redis.set(`cooldown:${key}`, '1', 'PX', COOLDOWN_MS);
  else mem.cooldowns.set(key, Date.now() + COOLDOWN_MS);
}

async function getSessionStore(sessionId) {
  if (redis) {
    const raw = await redis.get(`session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.sessions.get(sessionId) || null;
}

async function setSessionStore(sessionId, session) {
  if (redis) await redis.set(`session:${sessionId}`, JSON.stringify(session), 'EX', SESSION_TTL_SEC);
  else mem.sessions.set(sessionId, session);
}

async function getUserStore(socketId) {
  if (redis) {
    const raw = await redis.get(`user:${socketId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.socketToUser.get(socketId) || null;
}

async function setUserStore(socketId, user) {
  if (redis) await redis.set(`user:${socketId}`, JSON.stringify(user), 'EX', SESSION_TTL_SEC);
  else mem.socketToUser.set(socketId, user);
}

async function deleteUserStore(socketId) {
  if (redis) await redis.del(`user:${socketId}`);
  else mem.socketToUser.delete(socketId);
}

async function incrementConversationCount() {
  if (redis) return redis.incr('stats:conversations');
  mem.conversationCount += 1;
  return mem.conversationCount;
}

async function getConversationCount() {
  if (redis) {
    const v = await redis.get('stats:conversations');
    return v ? parseInt(v, 10) : 0;
  }
  return mem.conversationCount;
}

// ---------------- queue maintenance ----------------
async function cleanQueue(role) {
  const arr = await queueRead(role);
  const fresh = arr.filter((u) => Date.now() - u.joinedAt < STALE_MS);
  if (fresh.length !== arr.length) await queueWriteAll(role, fresh);
  return fresh;
}

async function getQueueCounts() {
  const [venter, listener, flexible] = await Promise.all([
    cleanQueue('venter'), cleanQueue('listener'), cleanQueue('flexible'),
  ]);
  return { venter: venter.length, listener: listener.length, flexible: flexible.length };
}

// Finds the earliest-waiting candidate in `queueArr` who is NOT on cooldown
// with `myAnonId`. Returns { candidate, rest } — rest is the queue with that
// one candidate removed (or the original queue if nobody usable was found).
async function pickCandidate(queueArr, myAnonId) {
  for (let i = 0; i < queueArr.length; i += 1) {
    const candidate = queueArr[i];
    // eslint-disable-next-line no-await-in-loop
    const cool = await isOnCooldown(myAnonId, candidate.anonId);
    if (!cool) {
      const rest = queueArr.slice(0, i).concat(queueArr.slice(i + 1));
      return { candidate, rest };
    }
  }
  return { candidate: null, rest: queueArr };
}

async function finalizeMatch(self, selfRole, partner, partnerRole) {
  const sessionId = uuidv4();
  const session = {
    startedAt: Date.now(),
    status: 'active',
    [selfRole]: self,
    [partnerRole]: partner,
  };
  await setSessionStore(sessionId, session);
  await setUserStore(self.socketId, { anonId: self.anonId, name: self.name, role: selfRole, sessionId });
  await setUserStore(partner.socketId, { anonId: partner.anonId, name: partner.name, role: partnerRole, sessionId });
  await incrementConversationCount();
  return { matched: true, sessionId, partnerSocketId: partner.socketId, partnerName: partner.name, assignedRole: selfRole };
}

// role is 'venter', 'listener', or 'flexible' (no preference — match with whoever's around).
async function joinQueue(role, socketId, anonId, name) {
  const self = { socketId, anonId, name, joinedAt: Date.now() };

  if (role === 'venter' || role === 'listener') {
    const opposite = role === 'venter' ? 'listener' : 'venter';

    let { candidate, rest } = await pickCandidate(await cleanQueue(opposite), anonId);
    if (candidate) {
      await queueWriteAll(opposite, rest);
      return finalizeMatch(self, role, candidate, opposite);
    }

    ({ candidate, rest } = await pickCandidate(await cleanQueue('flexible'), anonId));
    if (candidate) {
      await queueWriteAll('flexible', rest);
      return finalizeMatch(self, role, candidate, opposite);
    }

    await queuePush(role, self);
    return { matched: false };
  }

  // role === 'flexible': take whichever role is actually needed right now.
  let { candidate, rest } = await pickCandidate(await cleanQueue('venter'), anonId);
  if (candidate) {
    await queueWriteAll('venter', rest);
    return finalizeMatch(self, 'listener', candidate, 'venter');
  }

  ({ candidate, rest } = await pickCandidate(await cleanQueue('listener'), anonId));
  if (candidate) {
    await queueWriteAll('listener', rest);
    return finalizeMatch(self, 'venter', candidate, 'listener');
  }

  ({ candidate, rest } = await pickCandidate(await cleanQueue('flexible'), anonId));
  if (candidate) {
    await queueWriteAll('flexible', rest);
    return finalizeMatch(self, 'listener', candidate, 'venter'); // arbitrary but consistent split
  }

  await queuePush('flexible', self);
  return { matched: false };
}

async function leaveQueue(socketId) {
  await Promise.all(['venter', 'listener', 'flexible'].map(async (role) => {
    const arr = await queueRead(role);
    const filtered = arr.filter((u) => u.socketId !== socketId);
    if (filtered.length !== arr.length) await queueWriteAll(role, filtered);
  }));
}

async function getSession(sessionId) {
  return getSessionStore(sessionId);
}

async function endSession(sessionId) {
  const session = await getSessionStore(sessionId);
  if (session) {
    session.status = 'ended';
    await setSessionStore(sessionId, session);
  }
  return session;
}

async function getUserBySocket(socketId) {
  return getUserStore(socketId);
}

async function disconnectSocket(socketId) {
  await leaveQueue(socketId);
  const user = await getUserStore(socketId);
  await deleteUserStore(socketId);
  return user;
}

// Prevents the same two anonymous identities from being immediately
// rematched after a bad ending (abrupt disconnect or a report). Keyed by
// anonId, which is per-connection — reloading the page resets it. That's a
// deliberate tradeoff: no persistent fingerprinting/cookies just to make
// this stronger, at the cost of the cooldown only reliably holding within
// the same browser tab session.
async function applyCooldown(anonIdA, anonIdB) {
  await setCooldown(anonIdA, anonIdB);
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
  applyCooldown,
  getConversationCount,
  isRedisMode: () => !!redis,
};
