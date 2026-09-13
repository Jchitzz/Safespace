# safespace

Anonymous peer support: one person vents, one person listens (or either person
picks "Surprise Me" for an instant match either way), no accounts.

## What's in here

```
safespace/
├── server/
│   ├── index.js        Express + Socket.io server, wires everything together
│   ├── matching.js      Queue + session bookkeeping, cooldowns, conversation counter
│   │                    (in-memory by default, Redis-backed if REDIS_URL is set)
│   ├── notes.js         Community note wall storage (same memory/Redis pattern)
│   └── moderation.js    Crisis-keyword detection, message sanitizing, resource text
├── public/
│   ├── index.html
│   ├── styles.css       Includes a light theme, toggled via a button in the corner
│   ├── app.js           Vanilla JS client (no build step needed)
│   └── terms.html       Terms of Service / Privacy Policy page
└── package.json
```

## Running it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two different browser windows (or one normal + one incognito, so they get separate sockets) — pick "Vent" in one and "Listen" in the other (or "Surprise Me" on either), and they'll match each other.

## Environment variables

| Variable | Required? | What it does |
|---|---|---|
| `PORT` | No | Defaults to 3000. Most hosts (Railway, Render) set this for you. |
| `REDIS_URL` | No | If set, matching state, sessions, cooldowns, the conversation counter, and the note wall all move to Redis, and Socket.IO's Redis adapter is enabled — this is what makes it safe to run more than one server instance. Without it, everything lives in memory in a single process. |
| `ADMIN_USER` | No | Username for `/admin/reports`. Defaults to `admin`. |
| `ADMIN_PASSWORD` | To enable the admin dashboard | If unset, `/admin/reports` and `/admin/bans` are disabled entirely (return a 503). Set this to turn on the password-protected admin dashboards. |
| `IPQS_API_KEY` | No | Enables VPN/proxy detection via IPQualityScore. Without it, that check is skipped entirely (fails open — never blocks on an unconfigured or failed lookup). |
| `BLOCK_VPN_TRAFFIC` | No | Set to `true` to actually reject connections flagged as VPN/proxy/Tor (requires `IPQS_API_KEY` to do anything). Off by default — read the "Banning and abuse prevention" section before turning this on. |

## How matching works

- Each browser tab gets an anonymous ID and a random display name (like "Quiet Fox") the moment it connects — never linked to an account, email, or stored IP.
- Pick Vent, Listen, or Surprise Me (no preference — you'll be matched as whichever role is actually needed). If someone compatible is already waiting, you're matched immediately; otherwise you wait until someone joins.
- **Re-match cooldown**: if a conversation ends abruptly (someone's tab closes) or gets reported, those two anonymous identities won't be matched with each other again for 30 minutes. This is keyed to the anonymous ID assigned on connect, so reloading the page resets it — a deliberate tradeoff to avoid adding persistent fingerprinting just to make the cooldown airtight.
- Chat messages are relayed only within that session's room — never persisted to disk or a database.

## Built-in safety features

- **Crisis-language detection** (`server/moderation.js`): if a venter's message contains phrases like "kill myself" or "want to die", the *venter* (not the listener) is shown a banner with the 988 Suicide & Crisis Lifeline (call, text, or chat at 988lifeline.org), the Crisis Text Line (text HOME to 741741), and findahelpline.com for outside the US. This is a keyword match, not an AI classifier — expect some false positives/negatives, and treat it as a supplement to human moderation, not a replacement. Re-verify these resources periodically — hotline numbers and services do occasionally change. The same crisis check also applies to community note wall submissions, which are silently held back (with the same resources shown to the author) rather than posted publicly.
- **Reporting**: either participant can report a session; reports are appended to `server/data/reports.log` as JSON lines with a timestamp, reason, and optional details, but no message content or IP. Filing a report also triggers the re-match cooldown between that pair.
- **A consent gate**: before using the matching screen, everyone has to click through a notice that this isn't therapy or crisis care, that they must be 18+, and a link to the full Terms & Privacy page.
- **A listener primer**: the first time someone picks "Listen," they see a short one-time screen of tips (you don't need to fix anything, it's okay not to know what to say, etc.) before joining the queue.
- **Rate limiting**: HTTP endpoints, chat messages (6 per 5 seconds), and note wall submissions (3 per 10 minutes) are all capped per-socket to blunt spam and abuse.
- **Session auto-timeout**: sessions hard-cap at 60 minutes and end automatically if either side disconnects.
- **Link stripping**: raw URLs in messages are stripped before relay, to cut down on phishing/spam vectors in a space where trust is high and scrutiny is low.

## Fun/community features

- **A rotating quote** on the home page, mixing ten written-in-house lines with anything submitted through the **community note wall** (moderated the same way chat messages are — length-capped, link-stripped, and held back if it contains crisis language).
- **A live counter** ("1,204 conversations so far") on the home page, ticking up every time two people are matched.
- **A breathing-pause screen** shown to venters (not listeners) after a conversation ends, before the rating screen — a brief, skippable moment rather than dropping straight into "rate your experience."
- **Light/dark theme toggle**, persisted across visits.

## Banning and abuse prevention

- **Automatic**: if the same IP address is reported 3 times within 24 hours, it's automatically banned for 7 days. This threshold and duration are constants at the top of `server/bans.js` if you want to tune them.
- **Manual**: visit `/admin/bans` (same Basic Auth as the reports dashboard) to see active bans, ban an IP directly, or unban one. The reports dashboard (`/admin/reports`) also has a one-click "Ban IP" form on each row that has a reported IP attached.
- **Optional VPN/proxy blocking**: set `IPQS_API_KEY` (a free-tier key from [IPQualityScore](https://www.ipqualityscore.com/)) and `BLOCK_VPN_TRAFFIC=true` to reject connections from detected VPNs, proxies, and Tor exit nodes entirely. This is off by default and worth thinking through before enabling — see the honest limitations below.

**Read this before you rely on any of it**: banning an IP stops that IP, not a person. On an anonymous, accountless site there's no persistent identity to actually ban — someone determined enough can switch networks, use a VPN, or reset their connection and come back with a new IP. This raises the cost of returning; it doesn't make it impossible, and no combination of IP + fingerprinting could make it impossible on a site built around anonymity. Enabling `BLOCK_VPN_TRAFFIC` also blocks legitimate privacy-conscious users, not just people evading a ban — that trade is yours to make deliberately, which is why it's off by default.

**Separately, and more importantly**: if a report ever involves apparent child sexual abuse material or exploitation, banning the person is not sufficient and may not even be the priority. U.S. federal law (18 U.S.C. § 2258A) requires electronic service providers to report this to NCMEC's CyberTipline (report.cybertip.org) — this is a legal obligation, not an optional moderation choice. This app's architecture deliberately does not retain conversation content, which is good for privacy but means there'd be nothing to report or preserve if something serious happened. Get real legal guidance before launch on what retention exception (if any) you need for this specific category, and don't treat the ban system in this README as covering that obligation — it doesn't.

## Admin reports dashboard

Set `ADMIN_PASSWORD` (and optionally `ADMIN_USER`) in your environment, then visit `/admin/reports` and sign in with those credentials (a browser Basic Auth prompt). It lists submitted reports, most recent first. This reads straight from `server/data/reports.log` — it does not yet read from Redis if you're running multi-instance, see the note below.

## Scaling past one instance

Set `REDIS_URL` and the app switches matching, sessions, cooldowns, the conversation counter, the note wall, and Socket.IO's own cross-instance messaging over to Redis. A few honest caveats about this mode, worth reading before you rely on it:

- **The queue pick-and-remove step is not atomic** (no Lua script/distributed lock). Under real concurrent load across multiple instances there's a small race window where two joiners could both think they matched the same waiting candidate. Fine at this app's likely scale; if you need airtight correctness under heavy concurrent traffic, move that step into a single Redis `EVAL` script.
- **The admin reports dashboard still reads the local log file**, not Redis — in multi-instance mode you'd only see reports that happened to land on whichever instance is serving your `/admin/reports` request. Worth moving reports into Redis (or a real database) too if you scale this up.

## Before you put this in front of real users

This is a much stronger foundation than it was, but still not a finished product. Given the subject matter, treat all of the below as required, not optional:

1. **Move reports (and the note wall, if you scale to Redis) into a real database**, not just Redis/a log file, with someone actually reviewing them on a cadence.
2. **Upgrade crisis detection.** The keyword list here is a starting point. Consider a proper moderation API/classifier, and decide up front what happens when it fires — who's notified, how fast, and what your legal exposure is if a user discloses active risk of harm to themselves or someone else. This is worth involving a lawyer and someone with clinical/crisis-response experience, not just an engineer.
3. **Have a lawyer review `public/terms.html`** before launch — it's a starting template, not finished legal copy. Fill in the date/email placeholders, and pay particular attention to the age/minors handling, crisis-liability language, and mandatory-reporting exposure (varies by jurisdiction and by whether anything here could be construed as counseling).
4. **Add abuse handling beyond reporting and the cooldown**: a way to permanently or temporarily block an anonymous ID or IP hash after repeated reports, so a bad actor doesn't just get re-queued with a new victim once the 30-minute cooldown expires.
5. **Serve over HTTPS** and lock down the Socket.io CORS origin (`server/index.js` currently allows `*` for local development).
6. **Load-test the matching queue** before any kind of launch — a burst of one role with none of the other (e.g. everyone wants to vent, nobody wants to listen) is the most likely real-world failure mode, and you'll want a plan for it (recruit/incentivize listeners, show expected wait time, offer resources while waiting).

## License

Use this however you like — it's a starting point, not a product.
