// background.js — fetches & caches the daily USD->CAD rate.
// MV3 service workers are ephemeral, so we schedule with chrome.alarms
// and cache the result in chrome.storage.local. Nothing here is page-facing.

const RATE_KEY = "fxRate";
const ALARM = "fxRefresh";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // treat a cached rate as fresh for 24h

// Pull USD->CAD from a free, no-key source. Frankfurter (ECB) is primary;
// open.er-api.com is a fallback if Frankfurter is ever unreachable.
async function fetchRate() {
  // Primary: Frankfurter — ECB reference rates, no API key.
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?from=USD&to=CAD", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const rate = j && j.rates && j.rates.CAD;
      if (rate) return { rate, date: j.date || null, source: "frankfurter" };
    }
  } catch (e) { /* fall through to backup */ }

  // Backup: open.er-api.com — also free, no key.
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const rate = j && j.rates && j.rates.CAD;
      if (rate) {
        const d = j.time_last_update_utc ? new Date(j.time_last_update_utc).toISOString().slice(0, 10) : null;
        return { rate, date: d, source: "er-api" };
      }
    }
  } catch (e) { /* give up gracefully */ }

  return null;
}

// Refresh the cached rate. Returns the stored record (or the stale cache, or null).
// Skips the network if the cache is fresh, and backs off 5 min after a failed
// fetch so a dead API doesn't get hammered by every getRate message.
const FAIL_KEY = "fxFailAt";
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;

async function refreshRate(force = false) {
  const stored = await chrome.storage.local.get([RATE_KEY, FAIL_KEY]);
  const cached = stored[RATE_KEY];
  if (!force) {
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached;
    if (stored[FAIL_KEY] && Date.now() - stored[FAIL_KEY] < FAIL_COOLDOWN_MS) {
      return cached || null; // recent failure — serve stale rather than refetch
    }
  }
  const res = await fetchRate();
  if (res) {
    const record = Object.assign({}, res, { fetchedAt: Date.now() });
    await chrome.storage.local.set({ [RATE_KEY]: record });
    await chrome.storage.local.remove(FAIL_KEY);
    return record;
  }
  await chrome.storage.local.set({ [FAIL_KEY]: Date.now() });
  return cached || null; // stale beats nothing
}

function ensureAlarm() {
  // Force-refresh every 6h (4 light API calls/day keeps the rate current).
  chrome.alarms.create(ALARM, { periodInMinutes: 360 });
}

chrome.runtime.onInstalled.addListener(() => {
  refreshRate(true);
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  refreshRate(false);
  ensureAlarm(); // alarms persist, but recreating is free and covers edge cases
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refreshRate(true);
});

// Content script / popup ask for the rate here so all network access lives in one place.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getRate") {
    refreshRate(!!msg.force).then((rec) => sendResponse({ ok: !!rec, rate: rec }));
    return true; // keep the message channel open for the async response
  }
});
