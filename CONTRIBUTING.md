# Contributing to TCG CAD Converter

Thanks for your interest in contributing!

## Reporting issues

Open a GitHub issue and include:

- The TCGplayer page where the problem occurred (URL if possible)
- What you expected to happen and what actually happened
- Browser and version

## Development setup

No build step is required — this is a plain Manifest V3 extension.

1. Clone the repository
2. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** the project folder
3. After editing files, click the reload icon on the extension card

## Pull requests

- Keep changes focused; one feature or fix per PR
- Match the existing code style (vanilla JavaScript, no frameworks, two-space indentation)
- Network access must remain limited to the exchange-rate APIs declared in the manifest
- Test on real TCGplayer pages before submitting

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
