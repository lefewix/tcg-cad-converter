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

const code = () => normCur(settings.targetCurrency);
const money = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: code() }).format(n);

// A cached rate from v1.0 has no `currency` field — that one is CAD.
const rateUsable = () => !!(fx && fx.rate && normCur(fx.currency || DEFAULT_CURRENCY) === code());

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
      : pct + "% market: " + money(100 * (pct / 100) * fx.rate);
  } else {
    $("previewCad").textContent = money(0).replace(/[\d.,]+/, "—"); // e.g. "CA$—"
    $("previewNote").textContent = "Waiting for today’s rate…";
  }
}

function renderRate() {
  const badge = $("liveBadge");
  $("rateLabel").textContent = "1 USD equals";
  if (rateUsable()) {
    $("rateVal").textContent = fx.rate.toFixed(4) + " " + code();
    const age = Date.now() - fx.fetchedAt;
    $("rateMeta").textContent =
      "Updated " + ago(age) + (fx.date ? " · " + fx.date : "") +
      (fx.source === "er-api" ? " · backup source" : "");
    badge.classList.toggle("stale", age > 24 * 3600 * 1000);
  } else {
    $("rateVal").textContent = "—";
    $("rateMeta").textContent = fx ? "Fetching " + code() + "…" : "No rate yet";
    badge.classList.add("stale");
  }
}

function renderAll() { renderPreview(); renderRate(); }

// ---- load ----
chrome.storage.sync.get({ percent: 90, targetCurrency: DEFAULT_CURRENCY }, (s) => {
  settings = s;
  $("percent").value = s.percent;
  $("currency").value = code();
  renderAll();
  if (!rateUsable()) askRate(false);
});
chrome.storage.local.get("fxRate", (o) => {
  fx = o.fxRate || null;
  renderAll();
  if (!rateUsable()) askRate(false);
});

// ---- interactions ----
let saveTimer = null;
$("percent").addEventListener("input", () => {
  const v = Math.max(1, Math.min(500, Number($("percent").value) || 90));
  settings.percent = v;
  renderPreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set({ percent: v }), 250);
});

$("currency").addEventListener("change", () => {
  settings.targetCurrency = normCur($("currency").value);
  chrome.storage.sync.set({ targetCurrency: settings.targetCurrency });
  renderAll();          // shows "Fetching EUR…" until the new rate lands
  askRate(false);
});

function askRate(force) {
  $("rateMeta").textContent = force ? "Refreshing…" : $("rateMeta").textContent;
  chrome.runtime.sendMessage({ type: "getRate", force: !!force, currency: code() }, (resp) => {
    if (chrome.runtime.lastError) { renderRate(); return; }
    if (resp && resp.ok && resp.rate) fx = resp.rate;
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
  if (area === "local" && changes.fxRate) { fx = changes.fxRate.newValue; renderAll(); }
});
