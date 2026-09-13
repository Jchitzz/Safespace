// server/bans.js
//
// IP ban list and report-volume auto-banning. Same dual memory/Redis
// pattern as matching.js and notes.js — see the note at the top of
// matching.js for why, and what changes if REDIS_URL is set.
//
// HONEST LIMITATION, worth reading before you rely on this: banning an IP
// stops that specific IP. It does not stop a specific PERSON, because on an
// anonymous, accountless site there is no persistent identity to ban —
// only signals (IP, device fingerprint) that a motivated person fully
// controls and can regenerate (new VPN endpoint, incognito window, a
// different device). This raises the cost of coming back; it does not make
// it impossible. See the README for the fuller version of this tradeoff.

const REDIS_URL = process.env.REDIS_URL;
let redis = null;
if (REDIS_URL) {
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  redis = new Redis(REDIS_URL);
}

const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling window for auto-ban counting
const REPORT_THRESHOLD = 3; // this many reports against one IP in the window triggers an auto-ban
const AUTO_BAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REPORT_COUNT_TTL_SEC = Math.ceil(REPORT_WINDOW_MS / 1000);

// ---------------- in-memory fallback store ----------------
const mem = {
  bans: new Map(), // ip -> { reason, bannedAt, expiresAt (or null = permanent) }
  reportTimestamps: new Map(), // ip -> [timestamps]
};

function isExpired(record) {
  return record.expiresAt !== null && Date.now() > record.expiresAt;
}

async function banIp(ip, reason, durationMs) {
  const record = {
    reason: reason || 'unspecified',
    bannedAt: Date.now(),
    expiresAt: durationMs ? Date.now() + durationMs : null, // null = permanent
  };
  if (redis) {
    await redis.set(`ban:${ip}`, JSON.stringify(record));
    if (durationMs) await redis.pexpire(`ban:${ip}`, durationMs);
  } else {
    mem.bans.set(ip, record);
  }
  return record;
}

async function unbanIp(ip) {
  if (redis) await redis.del(`ban:${ip}`);
  else mem.bans.delete(ip);
}

async function isBanned(ip) {
  if (!ip) return null;
  if (redis) {
    const raw = await redis.get(`ban:${ip}`);
    return raw ? JSON.parse(raw) : null;
  }
  const record = mem.bans.get(ip);
  if (!record) return null;
  if (isExpired(record)) {
    mem.bans.delete(ip);
    return null;
  }
  return record;
}

async function listBans() {
  if (redis) {
    const keys = await redis.keys('ban:*');
    if (keys.length === 0) return [];
    const values = await redis.mget(keys);
    return keys.map((k, i) => ({ ip: k.slice(4), ...JSON.parse(values[i]) }))
      .sort((a, b) => b.bannedAt - a.bannedAt);
  }
  const out = [];
  mem.bans.forEach((record, ip) => {
    if (!isExpired(record)) out.push({ ip, ...record });
  });
  return out.sort((a, b) => b.bannedAt - a.bannedAt);
}

// Records a report against an IP, and auto-bans it if it crosses the
// threshold within the rolling window. Returns the ban record if one was
// just created, otherwise null.
async function recordReportForIp(ip) {
  if (!ip) return null;
  const now = Date.now();

  if (redis) {
    const key = `reportcount:${ip}`;
    await redis.rpush(key, now);
    await redis.expire(key, REPORT_COUNT_TTL_SEC);
    const raw = await redis.lrange(key, 0, -1);
    const fresh = raw.map(Number).filter((t) => now - t < REPORT_WINDOW_MS);
    if (fresh.length !== raw.length) {
      await redis.del(key);
      if (fresh.length > 0) {
        const pipeline = redis.pipeline();
        fresh.forEach((t) => pipeline.rpush(key, t));
        pipeline.expire(key, REPORT_COUNT_TTL_SEC);
        await pipeline.exec();
      }
    }
    if (fresh.length >= REPORT_THRESHOLD && !(await isBanned(ip))) {
      return banIp(ip, `Auto-banned: ${fresh.length} reports within 24 hours`, AUTO_BAN_MS);
    }
    return null;
  }

  const timestamps = (mem.reportTimestamps.get(ip) || []).filter((t) => now - t < REPORT_WINDOW_MS);
  timestamps.push(now);
  mem.reportTimestamps.set(ip, timestamps);
  if (timestamps.length >= REPORT_THRESHOLD && !(await isBanned(ip))) {
    return banIp(ip, `Auto-banned: ${timestamps.length} reports within 24 hours`, AUTO_BAN_MS);
  }
  return null;
}

module.exports = {
  banIp,
  unbanIp,
  isBanned,
  listBans,
  recordReportForIp,
  REPORT_THRESHOLD,
};
