# TCG CAD Converter

A browser extension that shows CAD conversions for USD prices on TCGplayer. Hover any price to see it converted using a live daily exchange rate, with an optional market-price percentage for estimating buylist or trade values.

## Features

- **Hover to convert** — a tooltip appears next to any USD price on TCGplayer with its CAD equivalent
- **Market percentage** — set your own percentage (e.g. 90%) to see adjusted values alongside the straight conversion
- **Live daily rate** — USD→CAD from Frankfurter (European Central Bank reference rates), with an automatic fallback source
- **Price ranges** — elements containing two prices (e.g. low–high market ranges) are converted as a range
- **Non-invasive** — the page itself is never modified; the tooltip floats above it

## Installation

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome, Brave, or Edge
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this project folder

## Usage

1. Browse [tcgplayer.com](https://www.tcgplayer.com) and hover over any USD price — the CAD conversion appears in a tooltip
2. Click the toolbar icon to set your market price percentage and view the current exchange rate
3. Use **Refresh** in the popup to force a rate update

## How it works

- **Rates** — the background service worker fetches USD→CAD from [Frankfurter](https://frankfurter.dev) (ECB reference rates, no API key) and falls back to [open.er-api.com](https://open.er-api.com) if unreachable. The rate is cached in `chrome.storage.local`, treated as fresh for 24 hours, and refreshed on a 6-hour alarm. A short cooldown prevents hammering the APIs after a failed fetch.
- **Detection** — the content script uses event delegation to find prices under the cursor, so prices loaded later (scrolling, filtering, navigation) work automatically. TCGplayer is a React app, so the page is never rewritten — only a floating tooltip is rendered.

## Privacy

The only network requests are to the two public exchange-rate APIs listed above. No page content, browsing data, or personal information is collected or transmitted.

## Limitations

- Conversions use the ECB daily reference rate, which is not a retail exchange rate — treat values as estimates
- Only USD prices in standard formats (`$12.99`, `$1,234.56`) are detected

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Felix Wang
