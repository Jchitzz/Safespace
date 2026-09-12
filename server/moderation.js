// server/moderation.js
//
// Lightweight, transparent moderation helpers. This is intentionally simple:
// a maintained keyword list rather than an ML classifier. It will produce
// false positives (people vent in hyperbole) and false negatives (people who
// don't use these exact words). Treat it as a safety net, not a filter that
// blocks anything — it should only ever ADD a resource banner, never remove
// or hide a user's message.

const CRISIS_TERMS = [
  'suicide',
  'suicidal',
  'kill myself',
  'end my life',
  'end it all',
  'want to die',
  'wish i was dead',
  'better off dead',
  'not worth living',
  'no reason to live',
  'hurt myself',
  'harm myself',
];

const CRISIS_RESOURCE_MESSAGE =
  "You matter, and support is available. If things feel like too much right now, " +
  "you can reach the 988 Suicide & Crisis Lifeline by calling or texting 988, or chatting at " +
  "988lifeline.org, or the Crisis Text Line by texting HOME to 741741 \u2014 all are free, " +
  "confidential, and available 24/7 in the US. Outside the US, find a local line at " +
  "findahelpline.com.";

function containsCrisisLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CRISIS_TERMS.some((term) => lower.includes(term));
}

// Extremely small denylist for spam/abuse text you never want relayed as-is.
// Extend this with a real moderation provider (e.g. an external moderation
// API) before going to production with real users.
const BLOCKED_PATTERNS = [/https?:\/\/\S+/gi]; // strip raw links to reduce spam/phishing

function sanitizeMessage(text) {
  let clean = text;
  BLOCKED_PATTERNS.forEach((pattern) => {
    clean = clean.replace(pattern, '[link removed]');
  });
  return clean.slice(0, 2000); // hard cap message length
}

module.exports = {
  containsCrisisLanguage,
  sanitizeMessage,
  CRISIS_RESOURCE_MESSAGE,
};
