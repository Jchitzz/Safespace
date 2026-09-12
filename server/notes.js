// server/notes.js
//
// The community note wall: short anonymous encouragements left after a
// session, which get mixed into the home page's rotating quote. Same dual
// memory/Redis backend pattern as matching.js, for the same reason — if you
// run multiple instances, notes should be shared across them.

const REDIS_URL = process.env.REDIS_URL;
let redis = null;
if (REDIS_URL) {
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  redis = new Redis(REDIS_URL);
}

const MAX_NOTES = 200;
const NOTES_KEY = 'community_notes';
let memNotes = [];

async function addNote(text) {
  const entry = { text, ts: Date.now() };
  if (redis) {
    await redis.lpush(NOTES_KEY, JSON.stringify(entry));
    await redis.ltrim(NOTES_KEY, 0, MAX_NOTES - 1);
  } else {
    memNotes.unshift(entry);
    memNotes = memNotes.slice(0, MAX_NOTES);
  }
}

async function getNotes(limit = 50) {
  if (redis) {
    const raw = await redis.lrange(NOTES_KEY, 0, limit - 1);
    return raw.map((s) => JSON.parse(s).text);
  }
  return memNotes.slice(0, limit).map((n) => n.text);
}

module.exports = { addNote, getNotes };
