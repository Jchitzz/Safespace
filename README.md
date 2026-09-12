# safespace

Anonymous peer support: one person vents, one person listens, matched at random, no accounts.

## What's in here

```
safespace/
├── server/
│   ├── index.js        Express + Socket.io server, wires everything together
│   ├── matching.js      In-memory queue + session bookkeeping
│   └── moderation.js    Crisis-keyword detection, message sanitizing, resource text
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js           Vanilla JS client (no build step needed)
└── package.json
```

## Running it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two different browser windows (or one normal + one incognito, so they get separate sockets) — pick "Vent" in one and "Listen" in the other, and they'll match each other.

## How matching works

- Each browser tab gets an anonymous ID the moment it connects (a `uuid`, never linked to an account, email, or stored IP).
- Picking a role puts you in an in-memory queue. If someone with the opposite role is already waiting, you're matched immediately into a Socket.io room; otherwise you wait until someone joins.
- Chat messages are relayed only within that room — never persisted to disk or a database in this implementation.

## Built-in safety features

- **Crisis-language detection** (`server/moderation.js`): if a venter's message contains phrases like "kill myself" or "want to die", the *venter* (not the listener) is shown a banner with the 988 Suicide & Crisis Lifeline (call, text, or chat at 988lifeline.org), the Crisis Text Line (text HOME to 741741), and findahelpline.com for outside the US. This is a keyword match, not an AI classifier — expect some false positives/negatives, and treat it as a supplement to human moderation, not a replacement. Re-verify these resources periodically — hotline numbers and services do occasionally change.
- **Reporting**: either participant can report a session; reports are appended to `server/data/reports.log` as JSON lines with a timestamp, reason, and optional details, but no message content or IP.
- **Rate limiting**: both HTTP endpoints (`express-rate-limit`) and per-socket chat messages (a simple token bucket, 6 messages / 5 seconds) are capped to blunt spam and abuse.
- **Session auto-timeout**: sessions hard-cap at 60 minutes and end automatically if either side disconnects.
- **Link stripping**: raw URLs in messages are stripped before relay, to cut down on phishing/spam vectors in a space where trust is high and scrutiny is low.

## Before you put this in front of real users

This is a solid foundation, not a finished product. Given the subject matter, treat all of the below as required, not optional:

1. **Replace the in-memory queue/session store with Redis** if you run more than one server process — matching must be coordinated across instances or people will never get matched.
2. **Move reports out of a flat log file into a real database**, with an actual moderation dashboard and a human reviewing them on a real cadence. An unread log file is not a safety plan.
3. **Upgrade crisis detection.** The keyword list here is a starting point. Consider a proper moderation API/classifier, and decide up front what happens when it fires — who's notified, how fast, and what your legal exposure is if a user discloses active risk of harm to themselves or someone else. This is worth involving a lawyer and someone with clinical/crisis-response experience, not just an engineer.
4. **Write real terms of service and a privacy policy**, and decide your policy on law-enforcement requests, mandatory reporting (varies by jurisdiction and whether you're offering anything that could be construed as counseling), and data retention — even for a no-accounts app, you're logging IPs somewhere unless you deliberately strip them.
5. **Add abuse handling beyond reporting**: a way to permanently or temporarily block an anonymous ID or IP hash after repeated reports, so a bad actor doesn't just get re-queued with a new victim five seconds later.
6. **Serve over HTTPS** and lock down the Socket.io CORS origin (`server/index.js` currently allows `*` for local development).
7. **Load-test the matching queue** before any kind of launch — a burst of one role with none of the other (e.g. everyone wants to vent, nobody wants to listen) is the most likely real-world failure mode, and you'll want a plan for it (recruit/incentivize listeners, show expected wait time, offer resources while waiting).

## License

Use this however you like — it's a starting point, not a product.
