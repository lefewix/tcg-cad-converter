// content.js — runs on tcgplayer.com.
// Strategy: don't rewrite the page (TCGplayer is React and would wipe our edits).
// Instead we listen for hover via event delegation on the document, find the price
// under the cursor, and float a tooltip next to it. Event delegation means prices
// that load later (scroll, filter, navigation) are handled automatically — no
// MutationObserver needed for the tooltip itself.

(() => {
  const TIP_ID = "tcgcad-tip";

  // Matches "$1,234.56", "$12.99", "$1,000". Requires either a decimal or a
  // thousands group so we don't trigger on things like "$5 off".
  const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})/g;

  let settings = { percent: 90 };
  let fx = null;            // { rate, fetchedAt, date, source }
  let tip = null;
  let active = false;
  let lastInfo = null;      // { el, prices: [] }
  let lastEvt = null;

  // ---- state: settings (synced) + cached rate (local) ----
  chrome.storage.sync.get({ percent: 90 }, (s) => { settings = s; });

  chrome.storage.local.get("fxRate", (o) => {
    fx = o.fxRate || null;
    if (!fx || staleness(fx) > 24 * 3600 * 1000) requestRate(false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.percent) {
      settings.percent = changes.percent.newValue;
      if (active && lastInfo) render(lastInfo, lastEvt);
    }
    if (area === "local" && changes.fxRate) {
      fx = changes.fxRate.newValue;
      if (active && lastInfo) render(lastInfo, lastEvt);
    }
  });

  function staleness(f) { return Date.now() - ((f && f.fetchedAt) || 0); }

  let lastRateReq = 0;
  function requestRate(force) {
    // Throttle: without this, hovering prices while both APIs are down
    // would fire a request on every render.
    const now = Date.now();
    if (!force && now - lastRateReq < 30000) return;
    lastRateReq = now;
    try {
      chrome.runtime.sendMessage({ type: "getRate", force: !!force }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok && resp.rate) {
          fx = resp.rate;
          if (active && lastInfo) render(lastInfo, lastEvt);
        }
      });
    } catch (e) { /* extension context can be torn down on reload; ignore */ }
  }

  // ---- price extraction ----
  function pricesIn(text) {
    if (!text || text.length > 300) return []; // cheap guard BEFORE any regex work
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length > 40) return []; // avoid matching giant container blobs
    const out = [];
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(t)) && out.length < 2) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(n)) out.push(n);
    }
    return out;
  }

  // Walk up from the hovered node to find the tightest element that holds a price.
  function findPriceEl(start) {
    let el = start, hops = 0;
    while (el && hops < 4) {
      if (el.nodeType === 1) {
        const prices = pricesIn(el.textContent);
        if (prices.length) return { el, prices };
      }
      el = el.parentElement;
      hops++;
    }
    return null;
  }

  // ---- formatting ----
  const cad = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "CAD" }).format(n);
  const usd = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  function ago(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 90) return "just now";
    const m = Math.floor(s / 60); if (m < 90) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 36) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // ---- tooltip ----
  function ensureTip() {
    if (tip && document.body && document.body.contains(tip)) return tip;
    tip = document.createElement("div");
    tip.id = TIP_ID;
    (document.body || document.documentElement).appendChild(tip);
    return tip;
  }

  function render(info, evt) {
    if (!info) { hide(); return; }
    const t = ensureTip();
    const pct = Number(settings.percent) || 90;

    if (!fx || !fx.rate) {
      t.classList.remove("range");
      t.innerHTML =
        '<div class="tip-main">Fetching today\u2019s rate\u2026</div>' +
        '<div class="tip-foot">CAD will appear in a moment</div>';
      requestRate(false);
    } else {
      const rate = fx.rate;
      const sorted = info.prices.slice().sort((a, b) => a - b); // lo–hi regardless of DOM order
      const rows = sorted.map((p) => ({
        p,
        straight: p * rate,
        adj: p * (pct / 100) * rate
      }));
      // fx.date is third-party API data — strip anything HTML-ish before innerHTML
      const safeDate = fx.date ? String(fx.date).replace(/[<>&"']/g, "") : null;
      const footer =
        '<div class="tip-foot">Rate updated ' + ago(staleness(fx)) +
        (safeDate ? " \u00b7 " + safeDate : "") + "</div>";

      if (rows.length === 1) {
        const r = rows[0];
        t.classList.remove("range");
        const pctRow = pct === 100 ? "" :
          '<div class="tip-row"><span>' + pct + '% market</span><b>' + cad(r.adj) + "</b></div>";
        t.innerHTML =
          '<div class="tip-main"><span class="usd">' + usd(r.p) + '</span>' +
          '<span class="arrow">\u2192</span>' + cad(r.straight) + "</div>" +
          pctRow +
          '<div class="tip-row"><span>1 USD</span><b>' + rate.toFixed(4) + " CAD</b></div>" +
          footer;
      } else {
        const lo = rows[0], hi = rows[1];
        t.classList.add("range");
        const pctRow = pct === 100 ? "" :
          '<div class="tip-row"><span>' + pct + '% market</span><b>' + cad(lo.adj) + "\u2013" + cad(hi.adj) + "</b></div>";
        t.innerHTML =
          '<div class="tip-main">' + cad(lo.straight) + '<span class="arrow">\u2013</span>' + cad(hi.straight) + "</div>" +
          '<div class="tip-row"><span>USD range</span><b>' + usd(lo.p) + "\u2013" + usd(hi.p) + "</b></div>" +
          pctRow +
          '<div class="tip-row"><span>1 USD</span><b>' + rate.toFixed(4) + " CAD</b></div>" +
          footer;
      }
    }

    position(evt);
    t.classList.add("show");
    active = true;
  }

  function position(evt) {
    if (!tip || !evt) return;
    const pad = 14;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w + 6 > window.innerWidth) x = evt.clientX - w - pad;
    if (y + h + 6 > window.innerHeight) y = evt.clientY - h - pad;
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = Math.max(4, y) + "px";
  }

  function hide() {
    if (tip) tip.classList.remove("show");
    active = false;
    lastInfo = null;
  }

  // ---- events ----
  function onOver(e) {
    const info = findPriceEl(e.target);
    lastEvt = e;
    if (info) { lastInfo = info; render(info, e); }
    else hide();
  }
  function onMove(e) {
    if (active) { lastEvt = e; position(e); }
  }

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mousemove", onMove, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
})();
