// popup.js — wires the toolbar popup to chrome.storage and the background worker.

const $ = (id) => document.getElementById(id);
const cad = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "CAD" }).format(n);

let settings = { percent: 90 };
let fx = null;

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return "just now";
  const m = Math.floor(s / 60); if (m < 90) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 36) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function renderPreview() {
  const pct = Number(settings.percent) || 90;
  if (fx && fx.rate) {
    // Main line = straight conversion, matching the on-page tooltip
    $("previewCad").textContent = cad(100 * fx.rate);
    $("previewNote").textContent = pct === 100
      ? "straight convert \u00d7 " + fx.rate.toFixed(4)
      : pct + "% market: " + cad(100 * (pct / 100) * fx.rate);
  } else {
    $("previewCad").textContent = "CA$\u2014";
    $("previewNote").textContent = "Waiting for today\u2019s rate\u2026";
  }
}

function renderRate() {
  const badge = $("liveBadge");
  if (fx && fx.rate) {
    $("rateVal").textContent = fx.rate.toFixed(4) + " CAD";
    const age = Date.now() - fx.fetchedAt;
    $("rateMeta").textContent =
      "Updated " + ago(age) + (fx.date ? " \u00b7 " + fx.date : "") +
      (fx.source === "er-api" ? " \u00b7 backup source" : "");
    badge.classList.toggle("stale", age > 24 * 3600 * 1000);
  } else {
    $("rateVal").textContent = "\u2014";
    $("rateMeta").textContent = "No rate yet";
    badge.classList.add("stale");
  }
}

function renderAll() { renderPreview(); renderRate(); }

// ---- load ----
chrome.storage.sync.get({ percent: 90 }, (s) => {
  settings = s;
  $("percent").value = s.percent;
  renderAll();
});
chrome.storage.local.get("fxRate", (o) => {
  fx = o.fxRate || null;
  renderAll();
  if (!fx) askRate(false);
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

function askRate(force) {
  $("rateMeta").textContent = force ? "Refreshing\u2026" : $("rateMeta").textContent;
  chrome.runtime.sendMessage({ type: "getRate", force: !!force }, (resp) => {
    if (chrome.runtime.lastError) { renderRate(); return; }
    if (resp && resp.ok && resp.rate) fx = resp.rate;
    renderAll();
  });
}

$("refresh").addEventListener("click", () => askRate(true));

// keep popup in sync if options page changes something while open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.percent) {
    settings.percent = changes.percent.newValue;
    $("percent").value = settings.percent;
    renderAll();
  }
  if (area === "local" && changes.fxRate) { fx = changes.fxRate.newValue; renderAll(); }
});
