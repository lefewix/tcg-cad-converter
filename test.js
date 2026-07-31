// test.js — dependency-free unit tests for the content script's parsers.
// Run with: node test.js   (exits non-zero on any failure)
//
// content.js is an IIFE that only touches the DOM behind `typeof` guards, so it
// loads cleanly in Node. `location` and the handful of element methods the tests
// need are hand-rolled below — there is no jsdom and there should not be one.

const path = require("path");

// --- minimal element shim (only what isInteractive touches) ---
function parseSimple(sel) {
  const m = /^([a-z]*)(?:\[([a-z-]+)(?:=["']([^"']*)["'])?\])?$/i.exec(sel.trim());
  if (!m) throw new Error("shim can't parse selector: " + sel);
  return { tag: m[1] || null, attr: m[2] || null, val: m[3] === undefined ? null : m[3] };
}

class El {
  constructor(tag, attrs = {}, text = "") {
    this.tag = tag.toLowerCase();
    this.attrs = attrs;
    this.text = text;
    this.children = [];
    this.parentElement = null;
    this.nodeType = 1;
  }
  get htmlFor() { return this.attrs.for || null; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(" "); }
  get classList() {
    const cls = String(this.attrs.class || "").split(/\s+/).filter(Boolean);
    return { contains: (c) => cls.indexOf(c) >= 0 };
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.children;
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  contains(other) {
    let e = other;
    while (e) { if (e === this) return true; e = e.parentElement; }
    return false;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  matches(sel) {
    return sel.split(",").some((part) => {
      const s = parseSimple(part);
      if (s.tag && s.tag !== this.tag) return false;
      if (s.attr) {
        if (!(s.attr in this.attrs)) return false;
        if (s.val !== null && String(this.attrs[s.attr]) !== s.val) return false;
      }
      return true;
    });
  }
  closest(sel) {
    let el = this;
    while (el) { if (el.matches(sel)) return el; el = el.parentElement; }
    return null;
  }
  querySelector(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
}

// A DOM-free `location`; each test overwrites pathname/hostname.
global.location = { pathname: "/", hostname: "www.tcgplayer.com" };

const C = require(path.join(__dirname, "content.js"));
const need = (name) => C[name] || (() => { throw new Error(name + " is not exported"); });
const pricesIn = need("pricesIn");
const pickPrice = need("pickPrice");
const isCheckoutPage = need("isCheckoutPage");
const isInteractive = need("isInteractive");
const staleness = need("staleness");
const lastPriceIn = need("lastPriceIn");
const findAmountEl = need("findAmountEl");
const oldness = need("oldness");
const STALE_MS = C.STALE_MS || 24 * 3600 * 1000;

const B = require(path.join(__dirname, "background.js"));

// --- tiny assertion harness ---
// Assertions take thunks so a missing export or a throw is a reported failure,
// not a crash that hides every test after it.
let pass = 0;
const failures = [];
function val(x) {
  try { return typeof x === "function" ? x() : x; }
  catch (e) { return "THREW: " + e.message; }
}
function check(name, ok, detail) {
  if (val(ok) === true) { pass++; return; }
  failures.push(name + (detail ? "  — " + val(detail) : ""));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(val(actual)), e = JSON.stringify(expected);
  check(name, a === e, "got " + a + ", want " + e);
}
const group = (n) => console.log("\n" + n);

// =====================================================================
// Ranges — a range must read as one, and only as one.
// =====================================================================
group("ranges that MUST render as a range");
const LEGIT_RANGES = [
  ["$10.00 - $15.00", [10, 15]],
  ["$10.00 – $15.00", [10, 15]],            // en dash
  ["$10.00 — $15.00", [10, 15]],            // em dash
  ["$10.00 ‑ $15.00", [10, 15]],            // non-breaking hyphen
  ["$10.00 − $15.00", [10, 15]],            // minus sign
  ["$10.00--$15.00", [10, 15]],
  ["$10 to $15", [10, 15]],
  ["US$10.00 - US$15.00", [10, 15]],
  ["USD $1,200.00 - USD $1,500.00", [1200, 1500]],
  ["$1,000 – $2,500", [1000, 2500]],
  ["Market price: $10.00 - $15.00", [10, 15]],
];
for (const [text, want] of LEGIT_RANGES) {
  eq("range " + JSON.stringify(text), () => { const r = pricesIn(text); return [r.range, r.prices]; }, [true, want]);
}

group("claim words defeat the range (P1-1)");
const CLAIM_RANGES = [
  "You save $5.00 - $10.00",
  "Save $5.00 - $10.00",
  "Shipping $1.00 - $3.00",
  "Tax $1.00 - $3.00",
  "Coupon $5.00 - $10.00",
  "Store credit $5.00 - $10.00",
  "Was $5.00 - $10.00",
  "Reg $5.00 - $10.00",
  "Orig $5.00 - $10.00",
  "Discount $5.00 - $10.00",
  "Handling $1.00 to $3.00",
  "You save US$5.00 - US$10.00",
];
for (const text of CLAIM_RANGES) {
  eq("not a range " + JSON.stringify(text), () => { const r = pricesIn(text); return [r.range, r.prices]; }, [false, []]);
}

group("descending pairs are subtraction, not a range (P1-2)");
const DESCENDING = [
  "Discount: $50.00 - $10.00",
  "Balance due: $50.00 - $10.00",
  "$50.00 - $10.00",
  "$1,500.00 – $1,200.00",
  "Credit $50.00 - $10.00",
];
for (const text of DESCENDING) {
  eq("descending " + JSON.stringify(text), () => { const r = pricesIn(text); return [r.range, r.prices]; }, [false, []]);
}

group("ascending false-range attacks stay rejected");
const ATTACKS = [
  "$12.99 + $0.00 Shipping",
  "$12.99 $19.99",
  "Buy 1 for $10.00, 2 for $15.00",
  "$10.00 - $15.00 shipping",
  "$10.00 / $15.00",
  "$10.00 + $15.00",
  "Price $10.00 (was $15.00)",
  "From $10.00 up to $15.00",
  "$10.00 to $15.00 with tax",
  "$10.00 and $15.00",
  "Order #12345 $10.00 - $15.00",
  "$10.00 - $15.00 - $20.00",
  "Limited time clearance!! $5.00 - $9.00",   // 25-char prefix, over the cap
];
for (const text of ATTACKS) {
  eq("attack " + JSON.stringify(text), () => pricesIn(text).range, false);
}

// =====================================================================
// pickPrice — which amount in a mixed string is the price
// =====================================================================
group("pickPrice");
const PICKS = [
  ["$3.99 shipping $12.99", 12.99],            // P2-1: label between two amounts
  ["Was $19.99 now $12.99", 12.99],
  ["Shipping $0.99 Price $4.99", 4.99],
  ["Price $4.99 shipping $0.99", 4.99],
  ["Free shipping on $50.00+ · $12.99", 12.99],
  ["Save $5.00 — now $12.99", 12.99],
  ["$12.99 + $0.00 Shipping", 12.99],
  ["$12.99", 12.99],
  ["Save $5.00 $12.99 $19.99", null],          // two unclaimed amounts: show nothing
  ["Order total $84.50", 84.5],
];
for (const [text, want] of PICKS) {
  eq("pick " + JSON.stringify(text), () => pickPrice(text), want);
}
// The same cases through the public entry point — a missing or renamed export
// must never be able to hide one of these.
for (const [text, want] of PICKS) {
  eq("pricesIn " + JSON.stringify(text), () => pricesIn(text).prices, want === null ? [] : [want]);
}
// "Save $5.00 $12.99 $19.99" must be silent because two amounts are unclaimed,
// not because the parser gave up early — the first amount is still claimed.
eq("pick partial claim leaves >1 candidate", () => pickPrice("Save $5.00 $12.99"), 12.99);

// =====================================================================
// Staleness is measured on the rate's own date (P2-2)
// =====================================================================
group("staleness");
const sun = Date.parse("2026-07-26T12:00:00Z");   // Sunday
const tue = Date.parse("2026-07-28T15:00:00Z");   // Tuesday
const mon = Date.parse("2026-07-27T09:00:00Z");   // Monday morning

// Fetched seconds ago, but the ECB rate is Friday's: that is stale.
const weekend = { rate: 1.37, currency: "CAD", date: "2026-07-24", fetchedAt: sun - 60000 };
check("weekend gap is stale", () => staleness(weekend, sun) > STALE_MS,
  () => "age " + Math.round(staleness(weekend, sun) / 3600000) + "h");
check("weekend gap ~36h", () => Math.round(staleness(weekend, sun) / 3600000) === 36);
check("Monday morning on Friday's rate is stale", () => staleness(weekend, mon) > STALE_MS);

// Midweek "latest" is normally the previous day's fix — that must NOT warn.
const midweek = { rate: 1.37, currency: "CAD", date: "2026-07-27", fetchedAt: tue - 60000 };
check("previous-day rate is fresh", () => staleness(midweek, tue) <= STALE_MS,
  () => "age " + Math.round(staleness(midweek, tue) / 3600000) + "h");

// No date (backup source): fall back to the fetch clock.
const undated = { rate: 1.37, currency: "CAD", fetchedAt: tue - 3 * 3600000 };
eq("undated falls back to fetchedAt", () => staleness(undated, tue), 3 * 3600000);
check("undated stale after 2 days",
  () => staleness({ rate: 1, fetchedAt: tue - 50 * 3600000 }, tue) > STALE_MS);
eq("missing record is stale, not negative", () => staleness(null, tue) > STALE_MS, true);
eq("future date clamps at zero", () => staleness({ rate: 1, date: "2026-08-30" }, tue), 0);
eq("garbage date falls back", () => staleness({ rate: 1, date: "not-a-date", fetchedAt: tue }, tue), 0);

// =====================================================================
// Cart detection matches whole path segments
// =====================================================================
group("isCheckoutPage");
const PAGES = [
  ["/product/12345/cartel-aristocrat", "www.tcgplayer.com", false],
  ["/product/98765/carted-away", "www.tcgplayer.com", false],
  ["/search/magic/product?q=cart", "www.tcgplayer.com", false],
  ["/cart", "www.tcgplayer.com", true],
  ["/cart/", "www.tcgplayer.com", true],
  ["/uk/checkout/payment", "www.tcgplayer.com", true],
  ["/orders/12345", "www.tcgplayer.com", true],
  ["/shopping-cart", "www.tcgplayer.com", true],
  ["/anything", "checkout.tcgplayer.com", true],
  ["/anything", "cartel.tcgplayer.com", false],
];
for (const [pathname, hostname, want] of PAGES) {
  global.location = { pathname, hostname };
  eq("checkout " + hostname + pathname, () => isCheckoutPage(), want);
}
global.location = { pathname: "/", hostname: "www.tcgplayer.com" };

// =====================================================================
// Click-to-pin: a bare <label> must not swallow the click (P3)
// =====================================================================
group("isInteractive");
function nest(...specs) {
  let root = null, cur = null;
  for (const [tag, attrs] of specs) {
    const el = new El(tag, attrs || {});
    if (cur) cur.append(el); else root = el;
    cur = el;
  }
  return { root, leaf: cur };
}
eq("plain row is pinnable", () => isInteractive(nest(["div"], ["span"]).leaf), false);
eq("bare label row is pinnable", () => isInteractive(nest(["label"], ["span"]).leaf), false);
eq("link is not pinnable", () => isInteractive(nest(["a", { href: "/x" }], ["span"]).leaf), true);
eq("button is not pinnable", () => isInteractive(nest(["button"], ["span"]).leaf), true);
eq("role=button is not pinnable", () => isInteractive(nest(["div", { role: "button" }], ["span"]).leaf), true);
{
  const l = new El("label");
  const span = l.append(new El("span"));
  l.append(new El("input", { type: "checkbox" }));
  eq("label wrapping a control is not pinnable", () => isInteractive(span), true);
}
eq("label with for= is not pinnable",
  () => isInteractive(nest(["label", { for: "qty" }], ["span"]).leaf), true);

// =====================================================================
// RANGE_RE prefix boundary — up to 24 junk chars allowed, 25 rejected
// =====================================================================
group("RANGE_RE prefix boundary");
{
  const p24 = "x".repeat(24);
  const p25 = "x".repeat(25);
  eq("24-char prefix still a range", () => pricesIn(p24 + "$10.00 - $15.00").range, true);
  eq("25-char prefix rejected", () => pricesIn(p25 + "$10.00 - $15.00").range, false);
  eq("empty prefix is a range", () => pricesIn("$10.00 - $15.00").range, true);
}

// =====================================================================
// lastPriceIn — the checkout chip reads the LAST amount in a node
// =====================================================================
group("lastPriceIn");
eq("single amount", () => lastPriceIn("Order Total: $84.50"), 84.5);
eq("last of several", () => lastPriceIn("$10.00 $20.00"), 20);
eq("thousands", () => lastPriceIn("Total $1,234.56"), 1234.56);
eq("bare integer is not a price", () => lastPriceIn("$5 off"), null);
eq("no amount", () => lastPriceIn("Order Total:"), null);
eq("null text", () => lastPriceIn(null), null);

// =====================================================================
// findAmountEl — which element next to the total label holds the amount
// =====================================================================
group("findAmountEl");
{
  const label = new El("span", {}, "Order Total: $84.50");
  eq("amount inside the label itself", () => findAmountEl(label) === label, true);
}
{
  const row = new El("div");
  const label = row.append(new El("span", {}, "Order Total"));
  const amt = row.append(new El("span", {}, "$84.50"));
  eq("amount in next sibling", () => findAmountEl(label) === amt, true);
}
{
  const row = new El("div");
  const label = row.append(new El("span", {}, "Order Total"));
  row.append(new El("span", {}, "You save $10.00"));
  eq("claim-word sibling is rejected", () => findAmountEl(label), null);
}
{
  const row = new El("div");
  const label = row.append(new El("span", {}, "Order Total"));
  row.append(new El("span", {}, "$84.50 $3.00"));
  eq("two-amount sibling is ambiguous", () => findAmountEl(label), null);
}
{
  const row = new El("div");
  const amt = row.append(new El("b", {}, "$84.50"));
  const label = row.append(new El("span", {}, "Total"));
  eq("amount found via shared parent", () => findAmountEl(label) === amt, true);
}
{
  const row = new El("div");
  row.append(new El("b", {}, "$84.50"));
  row.append(new El("b", {}, "$3.00"));
  const label = row.append(new El("span", {}, "Total"));
  eq("ambiguous parent row is rejected", () => findAmountEl(label), null);
}
{
  const label = new El("span", {}, "Order Total");
  eq("no amount anywhere", () => findAmountEl(label), null);
}

// =====================================================================
// oldness — pluralization ("1 day old", never "1 days old")
// =====================================================================
group("oldness");
const HR = 3600000;
eq("1 hour", () => oldness(1 * HR), "1 hour old");
eq("36 hours", () => oldness(36 * HR), "36 hours old");
eq("2 days", () => oldness(49 * HR), "2 days old");
eq("no '1 days'", () => /\b1 days\b/.test(oldness(47.9 * HR)) || /\b1 days\b/.test(oldness(24 * HR)), false);

// =====================================================================
// background.js — rate validation + fetchRate date guard (async)
// =====================================================================
group("validRate");
eq("positive number ok", () => B.validRate(1.37), true);
eq("NaN rejected", () => B.validRate(NaN), false);
eq("string rejected", () => B.validRate("1.37"), false);
eq("negative rejected", () => B.validRate(-1), false);
eq("zero rejected", () => B.validRate(0), false);
eq("Infinity rejected", () => B.validRate(Infinity), false);
eq("undefined rejected", () => B.validRate(undefined), false);

group("date helpers");
eq("good ISO date passes", () => B.validDate("2026-07-30"), "2026-07-30");
eq("garbage date nulled", () => B.validDate("yesterday-ish"), null);
eq("non-string date nulled", () => B.validDate(20260730), null);
eq("good UTC string parsed", () => B.parseUpdateDate("Fri, 24 Jul 2026 00:02:31 +0000"), "2026-07-24");
const today = new Date().toISOString().slice(0, 10);
eq("bad UTC string falls back to fetch-day", () => B.parseUpdateDate("not a date at all"), today);
eq("missing UTC string falls back to fetch-day", () => B.parseUpdateDate(undefined), today);

(async () => {
  group("fetchRate (mocked network)");
  const mock = (handlers) => {
    global.fetch = async (url) => {
      for (const [frag, resp] of handlers) {
        if (url.indexOf(frag) >= 0) {
          if (resp === "netfail") throw new Error("network down");
          return { ok: true, json: async () => resp };
        }
      }
      throw new Error("unexpected url " + url);
    };
  };

  // Positive: primary healthy.
  mock([["frankfurter", { rates: { CAD: 1.37 }, date: "2026-07-29" }]]);
  let r = await B.fetchRate("CAD");
  eq("primary rate", r && r.rate, 1.37);
  eq("primary date", r && r.date, "2026-07-29");
  eq("primary source", r && r.source, "frankfurter");

  // Guard: primary down, backup returns a GOOD rate with a BAD date — the rate
  // must survive with a fetch-day date, not be thrown away by Date parsing.
  mock([["frankfurter", "netfail"],
        ["er-api", { rates: { CAD: 1.38 }, time_last_update_utc: "garbage!!" }]]);
  r = await B.fetchRate("CAD");
  eq("bad backup date keeps the rate", r && r.rate, 1.38);
  eq("bad backup date falls back to fetch-day", r && r.date, today);
  eq("backup source tagged", r && r.source, "er-api");

  // Negative: backup date parses normally.
  mock([["frankfurter", "netfail"],
        ["er-api", { rates: { CAD: 1.38 }, time_last_update_utc: "Wed, 29 Jul 2026 00:02:31 +0000" }]]);
  r = await B.fetchRate("CAD");
  eq("good backup date used", r && r.date, "2026-07-29");

  // Invalid rates are rejected even when the payload arrives.
  mock([["frankfurter", { rates: { CAD: "1.37" }, date: "2026-07-29" }], ["er-api", "netfail"]]);
  eq("string rate rejected end-to-end", await B.fetchRate("CAD"), null);
  mock([["frankfurter", { rates: { CAD: -2 }, date: "2026-07-29" }], ["er-api", "netfail"]]);
  eq("negative rate rejected end-to-end", await B.fetchRate("CAD"), null);
  mock([["frankfurter", { rates: { CAD: NaN }, date: "2026-07-29" }], ["er-api", "netfail"]]);
  eq("NaN rate rejected end-to-end", await B.fetchRate("CAD"), null);

  // Both sources dead: null, so the message handler answers {ok:false,error}.
  mock([["frankfurter", "netfail"], ["er-api", "netfail"]]);
  eq("both dead -> null", await B.fetchRate("CAD"), null);

  // Frankfurter with a malformed date still keeps its rate (date nulled).
  mock([["frankfurter", { rates: { CAD: 1.37 }, date: "not-a-date" }]]);
  r = await B.fetchRate("CAD");
  eq("primary bad date keeps rate", r && r.rate, 1.37);
  eq("primary bad date nulled", r && r.date, null);

  // --- summary ---
  console.log("\n" + "-".repeat(52));
  for (const f of failures) console.log("FAIL  " + f);
  console.log(pass + " passed, " + failures.length + " failed");
  process.exit(failures.length ? 1 : 0);
})();
