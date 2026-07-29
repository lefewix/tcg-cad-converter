// content.js — runs on tcgplayer.com.
// Strategy: don't rewrite the page (TCGplayer is React and would wipe our edits).
// Instead we listen for hover via event delegation on the document, find the price
// under the cursor, and float a tooltip next to it. Event delegation means prices
// that load later (scroll, filter, navigation) are handled automatically — no
// MutationObserver needed for the tooltip itself.
//
// The one exception is the cart/checkout order total, which we do annotate in place
// with a small chip; that runs behind a debounced MutationObserver and is idempotent.

(() => {
  const TIP_ID = "tcgcad-tip";
  const CHIP_CLASS = "tcgcad-total-chip";
  const DEFAULT_CURRENCY = "CAD";
  const CURRENCIES = ["CAD", "EUR", "GBP", "AUD", "JPY", "MXN"];
  const STALE_MS = 24 * 3600 * 1000;

  // Matches "$1,234.56", "$12.99", "$1,000". Requires either a decimal or a
  // thousands group so we don't trigger on things like "$5 off".
  const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})/g;

  // A range is only a range when the text actually reads as one: two amounts joined
  // by a dash or "to", nothing else between them, nothing trailing. This keeps
  // "$12.99 + $0.00 Shipping" from being presented as a confident "$0.00–$12.99".
  // Bare integers are allowed here (unlike PRICE_RE) because the surrounding
  // range grammar is evidence enough that "$10 to $15" really is money.
  const AMT = "\\$\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\d+(?:\\.\\d{2})?)";
  const RANGE_RE = new RegExp("^[^$\\d]{0,24}?" + AMT + "\\s*(?:-|\\u2013|\\u2014|to)\\s*" + AMT + "\\s*$", "i");

  let settings = { percent: 90, targetCurrency: DEFAULT_CURRENCY };
  let fx = null;            // { rate, currency, fetchedAt, date, source }
  let tip = null;
  let active = false;
  let pinned = false;
  let lastInfo = null;      // { el, prices: [], range: bool }
  let lastEvt = null;       // { clientX, clientY }
  let lastRateReq = 0;      // declared up here: storage callbacks can fire before
  let annotateTimer = null; // the rest of the file has evaluated

  const normCur = (c) => {
    const u = String(c || "").toUpperCase();
    return CURRENCIES.indexOf(u) >= 0 ? u : DEFAULT_CURRENCY;
  };
  const curCode = () => normCur(settings.targetCurrency);

  // ---- state: settings (synced) + cached rate (local) ----
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.sync.get({ percent: 90, targetCurrency: DEFAULT_CURRENCY }, (s) => {
      settings = s;
      if (!rateUsable()) requestRate(false);
      scheduleAnnotate();
    });

    chrome.storage.local.get("fxRate", (o) => {
      fx = o.fxRate || null;
      if (!rateUsable() || staleness(fx) > STALE_MS) requestRate(false);
      scheduleAnnotate();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && (changes.percent || changes.targetCurrency)) {
        if (changes.percent) settings.percent = changes.percent.newValue;
        if (changes.targetCurrency) {
          settings.targetCurrency = changes.targetCurrency.newValue;
          if (!rateUsable()) requestRate(false);
        }
        if (active && lastInfo) render(lastInfo, lastEvt);
        scheduleAnnotate();
      }
      if (area === "local" && changes.fxRate) {
        fx = changes.fxRate.newValue;
        if (active && lastInfo) render(lastInfo, lastEvt);
        scheduleAnnotate();
      }
    });
  }

  function staleness(f) { return Date.now() - ((f && f.fetchedAt) || 0); }

  // Records written by v1.0 carry no `currency` field — those are CAD.
  function rateUsable() {
    return !!(fx && fx.rate && normCur(fx.currency || DEFAULT_CURRENCY) === curCode());
  }

  function requestRate(force) {
    // Throttle: without this, hovering prices while both APIs are down
    // would fire a request on every render.
    const now = Date.now();
    if (!force && now - lastRateReq < 30000) return;
    lastRateReq = now;
    try {
      chrome.runtime.sendMessage({ type: "getRate", force: !!force, currency: curCode() }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok && resp.rate) {
          fx = resp.rate;
          if (active && lastInfo) render(lastInfo, lastEvt);
          scheduleAnnotate();
        }
      });
    } catch (e) { /* extension context can be torn down on reload; ignore */ }
  }

  // ---- price extraction ----
  // Returns { prices: [n, ...], range: bool }. `range` is true only when the source
  // text literally reads as a low–high range; otherwise callers use prices[0].
  function pricesIn(text) {
    if (!text || text.length > 300) return { prices: [], range: false }; // cheap guard BEFORE any regex work
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length > 40) return { prices: [], range: false }; // avoid matching giant container blobs

    const rm = RANGE_RE.exec(t);
    if (rm) {
      const a = parseFloat(rm[1].replace(/,/g, ""));
      const b = parseFloat(rm[2].replace(/,/g, ""));
      if (!isNaN(a) && !isNaN(b)) return { prices: [a, b], range: true };
    }

    const out = [];
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(t)) && out.length < 1) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(n)) out.push(n);
    }
    return { prices: out, range: false };
  }

  // Walk up from the hovered node to find the tightest element that holds a price.
  function findPriceEl(start) {
    let el = start, hops = 0;
    while (el && hops < 4) {
      if (el.nodeType === 1) {
        if (el.classList && el.classList.contains(CHIP_CLASS)) return null;
        const r = pricesIn(el.textContent);
        if (r.prices.length) return { el, prices: r.prices, range: r.range };
      }
      el = el.parentElement;
      hops++;
    }
    return null;
  }

  // ---- formatting ----
  const money = (n, code) => new Intl.NumberFormat("en-US", { style: "currency", currency: code || curCode() }).format(n);
  const usd = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  function ago(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 90) return "just now";
    const m = Math.floor(s / 60); if (m < 90) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 36) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // Plain-English age for the stale warning ("3 days old", not "72h ago").
  function oldness(ms) {
    const h = Math.floor(ms / 3600000);
    if (h < 48) return h + " hours old";
    return Math.floor(h / 24) + " days old";
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
    const code = curCode();

    if (!rateUsable()) {
      t.classList.remove("range");
      t.innerHTML =
        '<div class="tip-main">Fetching today’s rate…</div>' +
        '<div class="tip-foot">' + code + " will appear in a moment</div>";
      requestRate(false);
    } else {
      const rate = fx.rate;
      const isRange = !!info.range && info.prices.length > 1;
      const sorted = info.prices.slice(0, isRange ? 2 : 1).sort((a, b) => a - b); // lo–hi regardless of DOM order
      const rows = sorted.map((p) => ({ p, straight: p * rate, adj: p * (pct / 100) * rate }));

      // fx.date is third-party API data — strip anything HTML-ish before innerHTML
      const safeDate = fx.date ? String(fx.date).replace(/[<>&"']/g, "") : null;
      const age = staleness(fx);
      const stale = age > STALE_MS
        ? '<div class="tip-stale">Rate is ' + oldness(age) + " — popup to refresh</div>"
        : "";
      const footer =
        '<div class="tip-foot">Rate updated ' + ago(age) +
        (safeDate ? " · " + safeDate : "") + "</div>";
      const pinRow = pinned ? '<div class="tip-pin">Pinned · Esc or click away</div>' : "";
      const rateRow = '<div class="tip-row"><span>1 USD</span><b>' + rate.toFixed(4) + " " + code + "</b></div>";

      if (!isRange) {
        const r = rows[0];
        t.classList.remove("range");
        const pctRow = pct === 100 ? "" :
          '<div class="tip-row"><span>' + pct + '% market</span><b>' + money(r.adj) + "</b></div>";
        t.innerHTML =
          '<div class="tip-main"><span class="usd">' + usd(r.p) + '</span>' +
          '<span class="arrow">→</span>' + money(r.straight) + "</div>" +
          pctRow + rateRow + stale + footer + pinRow;
      } else {
        const lo = rows[0], hi = rows[1];
        t.classList.add("range");
        const pctRow = pct === 100 ? "" :
          '<div class="tip-row"><span>' + pct + '% market</span><b>' + money(lo.adj) + "–" + money(hi.adj) + "</b></div>";
        t.innerHTML =
          '<div class="tip-main">' + money(lo.straight) + '<span class="arrow">–</span>' + money(hi.straight) + "</div>" +
          '<div class="tip-row"><span>USD range</span><b>' + usd(lo.p) + "–" + usd(hi.p) + "</b></div>" +
          pctRow + rateRow + stale + footer + pinRow;
      }
    }

    t.classList.toggle("pinned", pinned);
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
    if (tip) { tip.classList.remove("show"); tip.classList.remove("pinned"); }
    active = false;
    pinned = false;
    lastInfo = null;
  }

  // ---- cart / checkout total annotation ----
  // Detect the order total by its *label text*, not by class names (those churn).
  const TOTAL_LABEL_RE = /^(order\s+total|grand\s+total|total\s+charged|amount\s+due|total\s+due|total)\s*:?\s*\$?[\d.,]*$/i;
  const NOT_TOTAL_RE = /sub\s*total|item|shipping|tax|discount|credit|saving/i;

  function isCheckoutPage() {
    const p = (location.pathname || "").toLowerCase();
    return /(^|\/)(cart|checkout|orders?)(\/|$)/.test(p) ||
      p.indexOf("/checkout") >= 0 || p.indexOf("/cart") >= 0 ||
      (location.hostname || "").indexOf("checkout") === 0;
  }

  function lastPriceIn(text) {
    if (!text) return null;
    const t = text.replace(/\s+/g, " ");
    let m, val = null;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(t))) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(n)) val = n;
    }
    return val;
  }

  // Given the element holding the total's label, find the element that shows the amount.
  function findAmountEl(labelEl) {
    if (lastPriceIn(labelEl.textContent) !== null) return labelEl;
    let sib = labelEl.nextElementSibling, n = 0;
    while (sib && n < 3) {
      if (lastPriceIn(sib.textContent) !== null) return sib;
      sib = sib.nextElementSibling; n++;
    }
    let parent = labelEl.parentElement, hops = 0;
    while (parent && hops < 2) {
      if ((parent.textContent || "").length < 120) {
        for (const child of parent.children) {
          if (child === labelEl || child.contains(labelEl)) continue;
          if (child.classList.contains(CHIP_CLASS)) continue;
          if (lastPriceIn(child.textContent) !== null) return child;
        }
      }
      parent = parent.parentElement; hops++;
    }
    return null;
  }

  function annotateTotals() {
    if (!document.body || !isCheckoutPage() || !rateUsable()) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const labels = [];
    let node, seen = 0;
    while ((node = walker.nextNode()) && seen < 6000) {
      seen++;
      const raw = node.nodeValue;
      if (!raw || raw.length > 40) continue;
      const t = raw.replace(/\s+/g, " ").trim();
      if (t.length < 5 || !TOTAL_LABEL_RE.test(t) || NOT_TOTAL_RE.test(t)) continue;
      const el = node.parentElement;
      if (el && !el.closest("#" + TIP_ID) && !el.classList.contains(CHIP_CLASS)) labels.push(el);
      if (labels.length >= 6) break;
    }

    for (const labelEl of labels) {
      const amountEl = findAmountEl(labelEl);
      if (!amountEl) continue;
      const value = lastPriceIn(amountEl.textContent);
      if (value === null) continue;
      const text = "≈ " + money(value * fx.rate);

      // Idempotent: reuse our chip if it's already the next sibling; never add a second.
      const next = amountEl.nextElementSibling;
      if (next && next.classList && next.classList.contains(CHIP_CLASS)) {
        if (next.textContent !== text) next.textContent = text;
        continue;
      }
      if (amountEl.querySelector && amountEl.querySelector("." + CHIP_CLASS)) continue;

      const chip = document.createElement("span");
      chip.className = CHIP_CLASS;
      chip.textContent = text;
      chip.title = "Converted at " + fx.rate.toFixed(4) + " " + curCode() + " per USD";
      amountEl.insertAdjacentElement("afterend", chip);
    }
  }

  function scheduleAnnotate() {
    if (typeof document === "undefined" || !document.body) return;
    clearTimeout(annotateTimer);
    annotateTimer = setTimeout(() => { try { annotateTotals(); } catch (e) { /* never break the page */ } }, 350);
  }

  function watchCart() {
    if (typeof MutationObserver === "undefined" || !document.body) return;
    const obs = new MutationObserver((records) => {
      // Ignore mutations that are only our own chips, otherwise we'd loop.
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains(CHIP_CLASS)) continue;
          scheduleAnnotate();
          return;
        }
        if (r.type === "characterData" || r.removedNodes.length) { scheduleAnnotate(); return; }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleAnnotate();
  }

  // ---- events ----
  function onOver(e) {
    if (pinned) return;
    const info = findPriceEl(e.target);
    lastEvt = e;
    if (info) { lastInfo = info; render(info, e); }
    else hide();
  }

  function onMove(e) {
    if (pinned) return;
    if (active) { lastEvt = e; position(e); }
  }

  function onClick(e) {
    if (pinned) { hide(); return; }           // click anywhere unpins
    const info = findPriceEl(e.target);
    if (!info) return;
    pinned = true;
    lastInfo = info;
    lastEvt = { clientX: e.clientX, clientY: e.clientY };
    render(info, lastEvt);
    e.preventDefault();                        // don't follow the price's link while pinning
    e.stopPropagation();
  }

  function onKey(e) {
    if (e.key === "Escape" && pinned) hide();
  }

  function onScroll() {
    if (!pinned) hide();                       // pinned tooltips survive scrolling
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", hide);
    watchCart();
  }

  // Exported for the offline parser harness; harmless in a browser (no `module`).
  if (typeof module !== "undefined" && module.exports) module.exports = { pricesIn, lastPriceIn };
})();
