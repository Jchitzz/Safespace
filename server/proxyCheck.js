// server/proxyCheck.js
//
// Optional VPN/datacenter-proxy detection, used only if IPQS_API_KEY is
// set. Uses IPQualityScore's free-tier Proxy Detection API (5,000 free
// lookups/month at the time of writing — check their current pricing).
//
// IMPORTANT TRADEOFF, decide deliberately before turning this on: blocking
// all VPN/proxy traffic also blocks privacy-conscious legitimate users, not
// just people evading a ban. This module never blocks anything by itself —
// it only reports a signal. Whether to act on that signal (and how
// aggressively) is decided in index.js via the BLOCK_VPN_TRAFFIC env var.
//
// FAILS OPEN: if no API key is set, or the lookup fails/times out for any
// reason, this always reports "not a proxy" rather than blocking traffic
// on an ambiguous result. An outage in a third-party service should never
// be the thing that takes your matching queue down.

const API_KEY = process.env.IPQS_API_KEY;
const CACHE_TTL_MS = 60 * 60 * 1000; // re-check the same IP at most once per hour
const cache = new Map(); // ip -> { result, checkedAt }

async function isLikelyVpnOrProxy(ip) {
  if (!API_KEY || !ip) return { checked: false, isProxy: false };

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(
      `https://ipqualityscore.com/api/json/ip/${API_KEY}/${encodeURIComponent(ip)}?strictness=1`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);
    if (!res.ok) return { checked: false, isProxy: false };
    const data = await res.json();
    const result = {
      checked: true,
      isProxy: !!(data.proxy || data.vpn || data.tor),
      fraudScore: data.fraud_score,
    };
    cache.set(ip, { result, checkedAt: Date.now() });
    return result;
  } catch (err) {
    // Network error, timeout, bad response — fail open, never block on ambiguity.
    return { checked: false, isProxy: false };
  }
}

module.exports = { isLikelyVpnOrProxy, isConfigured: () => !!API_KEY };
