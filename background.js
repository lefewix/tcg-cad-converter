// background.js — fetches & caches the daily USD->target-currency rate.
// MV3 service workers are ephemeral, so we schedule with chrome.alarms
// and cache the result in chrome.storage.local. Nothing here is page-facing.

const RATE_KEY = "fxRate";        // kept from v1.0 (CAD-only) so old installs keep working
const CUR_KEY = "targetCurrency"; // sync; absent on old installs => CAD
const ALARM = "fxRefresh";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // treat a cached rate as fresh for 24h
const FETCH_TIMEOUT_MS = 10000;         // don't let a hung API hold the worker open

const DEFAULT_CURRENCY = "CAD";
const CURRENCIES = ["CAD", "EUR", "GBP", "AUD", "JPY", "MXN"];

function normCur(c) {
  const u = String(c || "").toUpperCase();
  return CURRENCIES.indexOf(u) >= 0 ? u : DEFAULT_CURRENCY;
}

async function storedCurrency() {
  const s = await chrome.storage.sync.get({ [CUR_KEY]: DEFAULT_CURRENCY });
  return normCur(s[CUR_KEY]);
}

// A rate is only worth caching if it's a real, positive number.
function validRate(r) {
  return typeof r === "number" && isFinite(r) && r > 0;
}

// Frankfurter dates arrive as "YYYY-MM-DD"; anything else is treated as absent.
function validDate(d) {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// er-api's `time_last_update_utc` is a free-form date string. Parse defensively:
// a malformed value must never throw away a perfectly good rate. Falls back to
// the fetch day so staleness math still has something honest to work with.
function parseUpdateDate(s) {
  const t = Date.parse(s || "");
  const d = isNaN(t) ? new Date() : new Date(t);
  return d.toISOString().slice(0, 10);
}

// fetch with a hard timeout — a dead network should fail fast, not hang.
async function fetchJson(url) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Pull USD-><cur> from a free, no-key source. Frankfurter (ECB) is primary;
// open.er-api.com is a fallback if Frankfurter is ever unreachable.
// Both return a rates table keyed by currency code, so the code just passes through.
async function fetchRate(cur) {
  // Primary: Frankfurter — ECB reference rates, no API key.
  try {
    const j = await fetchJson("https://api.frankfurter.dev/v1/latest?from=USD&to=" + cur);
    const rate = j && j.rates && j.rates[cur];
    if (validRate(rate)) return { rate, currency: cur, date: validDate(j.date), source: "frankfurter" };
  } catch (e) { /* fall through to backup */ }

  // Backup: open.er-api.com — also free, no key.
  try {
    const j = await fetchJson("https://open.er-api.com/v6/latest/USD");
    const rate = j && j.rates && j.rates[cur];
    if (validRate(rate)) {
      return { rate, currency: cur, date: parseUpdateDate(j.time_last_update_utc), source: "er-api" };
    }
  } catch (e) { /* give up gracefully */ }

  return null;
}

// Refresh the cached rate. Returns the stored record (or the stale cache, or null).
// Skips the network if the cache is fresh AND for the right currency, and backs off
// 5 min after a failed fetch so a dead API doesn't get hammered by every getRate.
const FAIL_KEY = "fxFailAt";
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;

// One in-flight refresh per currency: a popup Refresh racing a currency-change
// listener joins the same promise instead of firing a second fetch.
const inflight = Object.create(null);

function refreshRate(force = false, currency) {
  const key = normCur(currency || "") + (currency ? "" : ":stored");
  if (inflight[key]) return inflight[key];
  const p = doRefresh(force, currency);
  inflight[key] = p;
  p.finally(() => { delete inflight[key]; }).catch(() => {});
  return p;
}

async function doRefresh(force, currency) {
  const cur = normCur(currency || (await storedCurrency()));
  const stored = await chrome.storage.local.get([RATE_KEY, FAIL_KEY]);
  const cached = stored[RATE_KEY];
  // Records written by v1.0 have no `currency` field — those are CAD.
  const cachedCur = cached ? normCur(cached.currency || DEFAULT_CURRENCY) : null;
  const usable = !!cached && cachedCur === cur;

  if (!force) {
    if (usable && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached;
    if (stored[FAIL_KEY] && Date.now() - stored[FAIL_KEY] < FAIL_COOLDOWN_MS) {
      // Recent failure — serve stale, but never a rate for the wrong currency.
      return usable ? cached : null;
    }
  }

  const res = await fetchRate(cur);
  if (res) {
    const record = Object.assign({}, res, { fetchedAt: Date.now() });
    // Rapid A→B→A currency switches: a slow fetch for B must not clobber the
    // cache after the user has already switched back to A. Only cache a rate
    // that still matches the user's current setting.
    if (cur === (await storedCurrency())) {
      await chrome.storage.local.set({ [RATE_KEY]: record });
      await chrome.storage.local.remove(FAIL_KEY);
    }
    return record;
  }
  await chrome.storage.local.set({ [FAIL_KEY]: Date.now() });
  return usable ? cached : null; // stale beats nothing, wrong currency does not
}

function ensureAlarm() {
  // Force-refresh every 6h (4 light API calls/day keeps the rate current).
  // Only create if absent so the cadence isn't reset on every browser startup.
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 360 });
  });
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onInstalled.addListener(() => {
    refreshRate(true);
    ensureAlarm();
  });

  chrome.runtime.onStartup.addListener(() => {
    refreshRate(false);
    ensureAlarm();
  });

  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM) refreshRate(true);
  });

  // Switching target currency invalidates the cache — fetch the new one immediately.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[CUR_KEY]) refreshRate(true, changes[CUR_KEY].newValue);
  });

  // Content script / popup ask for the rate here so all network access lives in one place.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "getRate") {
      refreshRate(!!msg.force, msg.currency).then(
        (rec) => sendResponse(rec
          ? { ok: true, rate: rec }
          : { ok: false, error: "Couldn't fetch rate — check connection" }),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true; // keep the message channel open for the async response
    }
  });
}

// Exported for the offline test harness; harmless in the service worker (no `module`).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { fetchRate, validRate, validDate, parseUpdateDate, normCur };
}
