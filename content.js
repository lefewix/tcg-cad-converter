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
  // The amount may carry a "US$" / "USD" / "USD $" prefix on either side of the dash,
  // and the dash itself has many renderings (ASCII, "--", en/em dash, non-breaking
  // hyphen U+2011, minus U+2212).
  const CUR = "(?:US\\s?\\$|USD\\s?\\$?|\\$)\\s?";
  const AMT = CUR + "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\d+(?:\\.\\d{2})?)";
  const DASH = "(?:--|[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212]|to)";
  const RANGE_RE = new RegExp("^[^$\\d]{0,24}?" + AMT + "\\s*" + DASH + "\\s*" + AMT + "\\s*$", "i");

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

    const n = pickPrice(t);
    return { prices: n === null ? [] : [n], range: false };
  }

  // Words that label an amount which is *not* the price we want: shipping, the
  // struck-through original, the discount. Each one claims the amount it sits next
  // to, so what's left over is the real price.
  const CLAIM_RE = /\b(shipping|ship|delivery|freight|handling|tax|fee|was|were|reg|regular|orig|original|originally|msrp|save|savings|discount|coupon|off)\b/gi;

  function allPrices(t) {
    const out = [];
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(t))) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(n)) out.push({ n, start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  // Choose which amount in a mixed string is the price. "Was $19.99 now $12.99" is
  // $12.99; "Shipping $0.99 Price $4.99" is $4.99. A marker claims the amount that
  // follows it when one is close by, otherwise the amount just before it — that
  // covers both "Shipping: $0.99" and "$0.00 Shipping". When several unclaimed
  // amounts remain in marker-bearing text we'd only be guessing, so we show nothing.
  function pickPrice(t) {
    const amounts = allPrices(t);
    if (!amounts.length) return null;
    if (amounts.length === 1) return amounts[0].n;

    const claimed = new Set();
    let mk, sawMarker = false;
    CLAIM_RE.lastIndex = 0;
    while ((mk = CLAIM_RE.exec(t))) {
      sawMarker = true;
      const at = mk.index, endAt = at + mk[0].length;
      let idx = amounts.findIndex((a, i) => a.start >= endAt && a.start - endAt <= 15 && !claimed.has(i));
      if (idx < 0) {
        for (let i = amounts.length - 1; i >= 0; i--) {
          if (amounts[i].end <= at && at - amounts[i].end <= 15 && !claimed.has(i)) { idx = i; break; }
        }
      }
      if (idx >= 0) claimed.add(idx);
    }

    const left = amounts.filter((_, i) => !claimed.has(i));
    if (left.length === 1) return left[0].n;
    if (!sawMarker) return amounts[0].n;   // no markers: unchanged first-price behaviour
    if (!left.length) return amounts[0].n; // every amount claimed: fall back to the first
    return null;                           // genuinely ambiguous — better to show nothing
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

  // Match whole path segments: "/product/12345/cartel-aristocrat" is not a cart.
  const CART_SEG = ["cart", "carts", "shopping-cart", "checkout", "order", "orders"];
  function isCheckoutPage() {
    const p = (location.pathname || "").toLowerCase();
    if (p.split("/").some((s) => CART_SEG.indexOf(s) >= 0)) return true;
    const host = (location.hostname || "").toLowerCase();
    const label = host.split(".")[0];
    return label === "cart" || label === "checkout";
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

  // Any other money label that could be sitting next to the total. If one of these
  // shows up in the row we're reading, we can't tell which amount is the total.
  const OTHER_MONEY_RE = /sub\s*total|shipping|ship\b|tax|fee|item|discount|credit|coupon|save|saving|reward|store\s*credit|off\b/i;
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  function priceCount(text) {
    let m, c = 0;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(text))) c++;
    return c;
  }

  // Given the element holding the total's label, find the element showing the amount.
  // The amount has to be in the label itself, in one of its next few siblings, or in
  // the nearest shared row — and that row has to be unambiguous. A "You save $10.00"
  // cousin two levels up is not the order total, so we annotate nothing instead.
  function findAmountEl(labelEl) {
    if (lastPriceIn(labelEl.textContent) !== null) return labelEl;

    let sib = labelEl.nextElementSibling, n = 0;
    while (sib && n < 3) {
      const txt = norm(sib.textContent);
      const isChip = sib.classList && sib.classList.contains(CHIP_CLASS);
      if (!isChip && lastPriceIn(txt) !== null) {
        if (OTHER_MONEY_RE.test(txt) || priceCount(txt) > 1) return null;
        return sib;
      }
      sib = sib.nextElementSibling; n++;
    }

    const labelTxt = norm(labelEl.textContent);
    let parent = labelEl.parentElement, hops = 0;
    while (parent && hops < 2) {
      const ptxt = norm(parent.textContent);
      if (lastPriceIn(ptxt) !== null) {
        if (ptxt.length > 120) return null;
        const rest = ptxt.replace(labelTxt, " ");
        if (priceCount(ptxt) !== 1 || OTHER_MONEY_RE.test(rest)) return null;
        for (const child of parent.children) {
          if (child === labelEl || child.contains(labelEl)) continue;
          if (child.classList && child.classList.contains(CHIP_CLASS)) continue;
          if (lastPriceIn(child.textContent) !== null) return child;
        }
        return null;
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

  // True for anything inside our own tooltip — its hover re-renders are not page news.
  function inOurUI(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return false;
    if (el.id === TIP_ID) return true;
    if (tip && tip.contains && tip.contains(el)) return true;
    return !!(el.closest && el.closest("#" + TIP_ID));
  }

  function watchCart() {
    if (typeof MutationObserver === "undefined" || !document.body) return;
    const obs = new MutationObserver((records) => {
      // Ignore mutations that are only our own chips or tooltip, otherwise every
      // hover re-render would schedule a scan (and chips would loop).
      for (const r of records) {
        if (inOurUI(r.target)) continue;
        let sawPageNode = false;
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains(CHIP_CLASS)) continue;
          if (inOurUI(n)) continue;
          sawPageNode = true;
        }
        if (sawPageNode) { scheduleAnnotate(); return; }
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

  // Prices on search results live *inside* the product card's <a>, and listing rows
  // put them next to "Add to cart". Pinning must never swallow those clicks, so we
  // only pin when the click lands on plain markup — and we never stop propagation.
  const INTERACTIVE_SEL = 'a[href],button,[role="button"],input,select,label,[onclick]';

  function onClick(e) {
    if (pinned) { hide(); return; }           // click anywhere unpins
    const t = e.target;
    const el = t && (t.nodeType === 1 ? t : t.parentElement);
    if (!el) return;
    if (el.closest && el.closest(INTERACTIVE_SEL)) return;  // let the page have it
    const info = findPriceEl(el);
    if (!info) return;
    pinned = true;
    lastInfo = info;
    lastEvt = { clientX: e.clientX, clientY: e.clientY };
    render(info, lastEvt);
    e.preventDefault();                        // a bare price has no default action anyway
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
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { pricesIn, lastPriceIn, findAmountEl, isCheckoutPage, onClick };
  }
})();
