# Review Rank

A Firefox extension that cleans up Amazon search results:

- Sorts by review rank and enforces Prime-only results automatically
- Blocks sponsored listings using independent DOM heuristics
- Hides products below a configurable minimum review count
- Optionally filters by brand using the [AmazonBrandFilterList](https://github.com/chris-mosley/AmazonBrandFilterList) allowlist

## Install

Install Review Rank from Mozilla Add-ons:

https://addons.mozilla.org/firefox/addon/review-rank/

Open the listing in Firefox and click **Add to Firefox**.

## Popup Controls

| Setting | Description |
|---|---|
| Extension enabled | Master on/off switch |
| Minimum review count | Hide products below this threshold |
| Hide sponsored results | Block sponsored listings |
| Use brand whitelist | Hide products not matching the allowlist |

The popup also shows a live summary of the active Amazon tab: visible/hidden counts by reason, Prime enforcement status, and whitelist health.

## Brand Whitelist

The bundled snapshot from [chris-mosley/AmazonBrandFilterList](https://github.com/chris-mosley/AmazonBrandFilterList) is available immediately on install. It refreshes from GitHub once per day and on demand via the **Refresh** button in the popup.

The only external network request the extension makes is to `raw.githubusercontent.com/chris-mosley/AmazonBrandFilterList` for this refresh.

## Development

```bash
npm run verify   # lint + test
npm run lint     # lint only
npm test         # test only
npm run format   # format with Biome
```

The test suite covers settings sanitization, locale-aware review count parsing (`.com`, `.de`, `.fr`, `.co.jp`), brand matching, sponsored label recognition, URL rewriting, and whitelist refresh logic.
