// popup.js — wires the toolbar popup to chrome.storage and the background worker.

const $ = (id) => document.getElementById(id);

const DEFAULT_CURRENCY = "CAD";
const CURRENCIES = ["CAD", "EUR", "GBP", "AUD", "JPY", "MXN"];
const normCur = (c) => {
  const u = String(c || "").toUpperCase();
  return CURRENCIES.indexOf(u) >= 0 ? u : DEFAULT_CURRENCY;
};

// `percent` and `fxRate` are the original v1.0 keys — kept so existing installs
// carry over untouched; `targetCurrency` is new and defaults to CAD.
let settings = { percent: 90, targetCurrency: DEFAULT_CURRENCY };
let fx = null;
let fxError = null;       // set when the background reports both rate APIs failed

const code = () => normCur(settings.targetCurrency);
const money = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: code() }).format(n);

// A cached rate from v1.0 has no `currency` field — that one is CAD.
const rateUsable = () => !!(fx && fx.rate && normCur(fx.currency || DEFAULT_CURRENCY) === code());

// Age of the rate itself, not of our fetch — the ECB publishes on weekdays only,
// so a Sunday fetch serves Friday's rate. Clock starts at the end of the rate's
// own day; falls back to fetchedAt when the record carries no date.
// Mirrors staleness() in content.js — keep the two in step.
function staleness(f, now) {
  const n = now === undefined ? Date.now() : now;
  const m = f && f.date && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f.date));
  if (m) {
    const end = Date.UTC(+m[1], +m[2] - 1, +m[3]) + 24 * 3600 * 1000;
    if (!isNaN(end)) return Math.max(0, n - end);
  }
  return n - ((f && f.fetchedAt) || 0);
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return "just now";
  const m = Math.floor(s / 60); if (m < 90) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 36) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function renderPreview() {
  const pct = Number(settings.percent) || 90;
  if (rateUsable()) {
    // Main line = straight conversion, matching the on-page tooltip
    $("previewCad").textContent = money(100 * fx.rate);
    $("previewNote").textContent = pct === 100
      ? "straight convert × " + fx.rate.toFixed(4)
      : pct + "% of the listed price: " + money(100 * (pct / 100) * fx.rate);
  } else {
    $("previewCad").textContent = money(0).replace(/[\d.,]+/, "—"); // e.g. "CA$—"
    $("previewNote").textContent = fxError
      ? "Couldn’t fetch rate — check connection"
      : "Waiting for today’s rate…";
  }
}

function renderRate() {
  const badge = $("liveBadge");
  const meta = $("rateMeta");
  $("rateLabel").textContent = "1 USD equals";
  meta.classList.remove("err");
  meta.title = "";
  if (rateUsable()) {
    $("rateVal").textContent = fx.rate.toFixed(4) + " " + code();
    const age = staleness(fx);
    meta.textContent =
      (fx.date ? "ECB rate " + fx.date + " · " : "") +
      "checked " + ago(Date.now() - (fx.fetchedAt || 0)) +
      (fx.source === "er-api" ? " · backup source" : "");
    if (fx.source === "er-api") {
      meta.title = "Frankfurter (ECB) was unreachable — this rate came from the backup provider, open.er-api.com.";
    }
    badge.classList.toggle("stale", age > 24 * 3600 * 1000);
  } else {
    $("rateVal").textContent = "—";
    if (fxError) {
      meta.textContent = "Couldn’t fetch rate — check connection";
      meta.classList.add("err");
    } else {
      meta.textContent = fx ? "Fetching " + code() + "…" : "No rate yet";
    }
    badge.classList.add("stale");
  }
}

function renderAll() { renderPreview(); renderRate(); }

// ---- load ----
// Settings first, cached rate second, and only THEN a rate request — asking
// before the currency is known would fetch/cache the default (CAD) even when
// the user has picked something else.
chrome.storage.sync.get({ percent: 90, targetCurrency: DEFAULT_CURRENCY }, (s) => {
  settings = s;
  $("percent").value = s.percent;
  $("currency").value = code();
  chrome.storage.local.get("fxRate", (o) => {
    fx = o.fxRate || null;
    renderAll();
    if (!rateUsable()) askRate(false);
  });
});

// ---- interactions ----
let saveTimer = null;
function clampPercent() {
  const raw = Number($("percent").value);
  const v = Math.max(1, Math.min(500, raw || 90));
  return { v, clamped: raw !== 0 && !isNaN(raw) && raw !== v };
}
$("percent").addEventListener("input", () => {
  const { v } = clampPercent();
  settings.percent = v;
  $("percentNote").hidden = true;
  renderPreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set({ percent: v }), 250);
});
// On commit (blur/Enter), write the clamped value back into the field and say so —
// the input must never display 900 while 500 is what's actually saved.
$("percent").addEventListener("change", () => {
  const { v, clamped } = clampPercent();
  $("percent").value = v;
  const note = $("percentNote");
  note.hidden = !clamped;
  if (clamped) note.textContent = "Adjusted to " + v + "% (allowed range 1–500)";
});

$("currency").addEventListener("change", () => {
  settings.targetCurrency = normCur($("currency").value);
  fxError = null;
  chrome.storage.sync.set({ targetCurrency: settings.targetCurrency });
  renderAll();          // shows "Fetching EUR…" until the new rate lands
  // No askRate here: the background's storage.onChanged listener already
  // force-refreshes for the new currency; a second request would race it.
});

let rateReqInFlight = false;
function askRate(force) {
  if (rateReqInFlight) return;
  rateReqInFlight = true;
  const btn = $("refresh");
  btn.disabled = true;
  if (force) {
    btn.textContent = "Refreshing…";
    $("rateMeta").textContent = "Refreshing…";
    $("rateMeta").classList.remove("err");
  }
  chrome.runtime.sendMessage({ type: "getRate", force: !!force, currency: code() }, (resp) => {
    rateReqInFlight = false;
    btn.disabled = false;
    btn.textContent = "Refresh";
    if (chrome.runtime.lastError) {
      fxError = "Couldn't reach the extension — try reopening the popup";
      renderAll();
      return;
    }
    if (resp && resp.ok && resp.rate) {
      fx = resp.rate;
      fxError = null;
    } else {
      // Both APIs failed — say so instead of silently reverting.
      fxError = (resp && resp.error) || "Couldn't fetch rate — check connection";
    }
    renderAll();
  });
}

$("refresh").addEventListener("click", () => askRate(true));

// keep popup in sync if another surface changes something while open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.percent) {
    settings.percent = changes.percent.newValue;
    $("percent").value = settings.percent;
    renderAll();
  }
  if (area === "sync" && changes.targetCurrency) {
    settings.targetCurrency = normCur(changes.targetCurrency.newValue);
    $("currency").value = code();
    renderAll();
  }
  if (area === "local" && changes.fxRate) {
    fx = changes.fxRate.newValue;
    if (rateUsable()) fxError = null;
    renderAll();
  }
});
