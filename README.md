<div align="center">

<img src="icons/icon128.png" width="88" alt="TCG Currency Converter icon">

# TCG Currency Converter

**See TCGplayer prices in your own currency, just by hovering.**

![Chrome extension](https://img.shields.io/badge/Chrome-extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

</div>

A browser extension that converts USD prices on TCGplayer into CAD (or EUR, GBP, AUD, JPY, MXN) using a live
daily exchange rate.

## Features

- **Hover to convert**: a tooltip shows the converted price next to any USD price
- **Pin the tooltip**: click a price to keep it in place while you scroll
- **Cart and checkout totals**: converted right on the page
- **Percentage view**: e.g. 90% of the price, for quick trade or buylist estimates
- **Live daily rate**: European Central Bank rates, with an automatic backup source
- **Handles messy prices**: ranges, "Was $19.99 now $12.99", shipping lines

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome, Brave or Edge and turn on **Developer mode**
3. Click **Load unpacked** and select this folder

## Usage

1. Browse [tcgplayer.com](https://www.tcgplayer.com) and hover over any price
2. Click a price to pin the tooltip; press Esc to unpin
3. Click the toolbar icon to change currency, set a percentage, or refresh the rate

## How it works

A background worker fetches the rate from [Frankfurter](https://frankfurter.dev) (ECB rates, no API key),
falling back to [open.er-api.com](https://open.er-api.com). It's cached for 24 hours. The page script finds
prices under the cursor with event delegation, so prices loaded later work too. TCGplayer's React pages are
never rewritten: only a floating tooltip is drawn.

<details>
<summary><b>More details</b></summary>

- **Price ranges** are shown only when the text really reads as one (`$10.00 – $15.00`, `$10 to $15`).
  "You save $5.00 - $10.00" belongs to its label, and a descending pair is a subtraction, so neither is
  shown as a range.
- **Mixed text** like `$3.99 shipping $12.99` converts the actual price, not the first number. If it stays
  ambiguous, nothing is shown.
- **Stale-rate warning**: rate age is measured from the rate's own publication date. The ECB publishes on
  weekdays only, so a weekend rate is correctly reported as 1 to 3 days old.
- **Cart totals** are found by their label text, not class names, and re-applied when React re-renders.
- **The percentage** applies to the listing price under your cursor, not to an average of recent sales.

</details>

## Privacy

The only network requests go to the two public exchange-rate APIs. No page content or personal data is
collected or sent.

## Development

No build step and no dependencies.

```
node test.js    # price parsing, ranges, rate staleness, cart detection
```

## License

[MIT](LICENSE) © Felix Wang
