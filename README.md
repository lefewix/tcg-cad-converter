# TCG CAD Converter

A browser extension that converts USD prices on TCGplayer into your own currency (CAD by default). Hover any price to see it converted using a live daily exchange rate, with an optional market-price percentage for estimating buylist or trade values.

## Features

- **Hover to convert** — a tooltip appears next to any USD price on TCGplayer with its converted equivalent
- **Pin the tooltip** — click a plain price to pin the tooltip in place; it stops following the cursor and survives scrolling. Esc or a click elsewhere unpins. Clicks on links, buttons, and other controls always go to the page, so search results and "Add to cart" keep working
- **Cart & checkout totals** — on cart and checkout pages the order total is annotated in place with a small converted chip
- **Choose your currency** — CAD, EUR, GBP, AUD, JPY, or MXN, set in the popup and synced across your browsers
- **Market percentage** — set your own percentage (e.g. 90%) to see adjusted values alongside the straight conversion
- **Live daily rate** — from Frankfurter (European Central Bank reference rates), with an automatic fallback source
- **Price ranges** — a range is shown only when the text actually reads as one (`$10.00 – $15.00`, `US$10.00 - US$15.00`, `$10 to $15`); anything else converts a single price
- **Mixed price text** — when a string carries shipping, sale, or discount labels (`Was $19.99 now $12.99`), the actual price is converted rather than the first number; if it stays ambiguous, nothing is shown
- **Stale-rate warning** — if the cached rate is over 24 hours old, the tooltip says so

## Installation

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome, Brave, or Edge
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this project folder

## Usage

1. Browse [tcgplayer.com](https://www.tcgplayer.com) and hover over any USD price — the CAD conversion appears in a tooltip
2. Click a price to pin the tooltip; press Esc or click elsewhere to unpin
3. Click the toolbar icon to pick your target currency, set your market price percentage, and view the current exchange rate
4. Use **Refresh** in the popup to force a rate update

## How it works

- **Rates** — the background service worker fetches USD→your currency from [Frankfurter](https://frankfurter.dev) (ECB reference rates, no API key) and falls back to [open.er-api.com](https://open.er-api.com) if unreachable. The rate is cached in `chrome.storage.local`, treated as fresh for 24 hours, and refreshed on a 6-hour alarm. A short cooldown prevents hammering the APIs after a failed fetch.
- **Detection** — the content script uses event delegation to find prices under the cursor, so prices loaded later (scrolling, filtering, navigation) work automatically. TCGplayer is a React app, so product pages are never rewritten — only a floating tooltip is rendered. The one in-place edit is the cart/checkout total chip, which is found by the total's label text (not by class names), is re-applied by a debounced `MutationObserver` when React re-renders, and is never added twice. Cart pages are matched on whole path segments, and when the amount next to a total label is ambiguous (a neighbouring "You save" or shipping line) nothing is annotated rather than guessing.

## Privacy

The only network requests are to the two public exchange-rate APIs listed above. No page content, browsing data, or personal information is collected or transmitted.

## Limitations

- Conversions use the ECB daily reference rate, which is not a retail exchange rate — treat values as estimates
- Only USD prices in standard formats (`$12.99`, `$1,234.56`) are detected

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Felix Wang
