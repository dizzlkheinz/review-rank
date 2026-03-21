# Prime Rank Filter

Cross-browser Amazon search extension for Firefox and Chrome that:

- forces Amazon search results to `s=review-rank`
- enforces Prime-only results when Amazon exposes a usable Prime facet token
- blocks sponsored posts using independent DOM/text heuristics
- hides listings below a configurable minimum ratings count
- optionally hides listings whose visible brand does not match a refreshed allowlist from `chris-mosley/AmazonBrandFilterList`
- reports current-page filtering status and whitelist health in the popup

## Runtime Shape

- Amazon page access stays limited to Amazon domains.
- The only non-Amazon network access is the background refresh request to `raw.githubusercontent.com` for the brand whitelist.
- The content script no longer ships the bundled whitelist into every Amazon tab.
- Shared parsing and settings logic now lives in `prime-rank-shared.js`.

## Files

- `manifest.json`: MV3 manifest with Firefox and Chrome background configuration
- `prime-rank-shared.js`: shared settings, parsing, URL rewrite, and whitelist helpers
- `amazon-brand-whitelist.js`: bundled AmazonBrandFilterList snapshot
- `background.js`: bundled fallback, GitHub refresh, popup status API, and alarm scheduling
- `content-script.js`: Amazon search filtering, Prime token detection, and page-status reporting
- `popup.html`: popup UI
- `popup.css`: popup styling
- `popup.js`: popup settings, whitelist refresh, and active-tab status logic
- `icons/`: packaged toolbar icons
- `test/`: Node fixtures and helper tests

## Install

### Firefox desktop

1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on...`.
3. Select `manifest.json`.

### Firefox for Android

1. Install/load the extension through Firefox’s extension tooling or collection flow.
2. Open the extension from Firefox’s extensions/settings UI.
3. The popup shows the active Amazon tab’s current filtering status.

### Chrome / Chromium

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.

## Popup

The popup controls:

- extension enabled state
- minimum review threshold
- sponsored-result blocking
- brand-whitelist mode
- manual whitelist refresh from GitHub

It also shows:

- current Amazon tab summary
- Prime enforcement status
- hidden result counts by reason
- whitelist source, size, refresh time, and last refresh error

## Testing

Run:

```bash
npm test
```

The test suite covers:

- shared settings sanitization
- locale-aware review-count parsing for `.com`, `.de`, `.fr`, and `.co.jp`
- allowlist brand matching
- sponsored-label recognition
- deterministic Amazon URL rewriting
- whitelist parsing and refresh-age logic

## Notes

- Sponsored blocking was implemented independently; no GPL code was copied from Amazon Unsponsor.
- Prime enforcement is deterministic when a Prime token can be extracted from the page or current URL. If Amazon does not expose a token on a given search surface, the popup will report that Prime enforcement is unavailable for that page while still applying the other filters.
- Brand matching is still best-effort and title/byline based, so treat whitelist mode as conservative rather than perfect brand identification.
- The bundled whitelist snapshot is available immediately and then refreshed from GitHub at startup, once per day, and on demand from the popup.
