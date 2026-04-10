# Review Rank — Firefox Extension

## Commands

```bash
npm run verify   # lint + test (run before committing)
npm run lint     # Biome check only
npm test         # node --test (Node built-in runner, no Jest)
npm run format   # Biome format --write
```

## Architecture

| File | Runs in | Role |
|------|---------|------|
| `background.js` | Service worker | Brand whitelist sync, alarm scheduling |
| `content-script.js` | Page context | DOM filtering: Prime enforcement, sponsored hiding, review threshold |
| `popup.js` / `popup.html` | Extension popup | Settings UI, live tab status |
| `prime-rank-shared.js` | All contexts | Shared UMD module (settings defaults, parsing helpers, storage keys) |
| `amazon-brand-whitelist.js` | All contexts | Bundled whitelist snapshot (auto-excluded from Biome formatting) |

## Gotchas

- **Firefox MV3 compat**: `manifest.json` lists both `background.scripts` (Firefox) and `background.service_worker` (Chrome). Keep both.
- **Shared module pattern**: `prime-rank-shared.js` uses a UMD IIFE that attaches to `globalThis.PrimeRankShared`. Import via `importScripts` in the service worker and via `<script>` in popup — not ES modules.
- **`amazon-brand-whitelist.js` is generated**: Do not hand-edit. It is excluded from Biome formatting in `biome.json`.
- **No host_permissions for Amazon domains**: Content scripts are declared in manifest; no broad host permissions needed. The only external request is to `raw.githubusercontent.com` (already in `host_permissions`).
- **Prime token**: Prime enforcement only works when Amazon exposes a `p_85:…` facet token in the page URL/DOM. Missing token = feature silently skipped, reported in popup.
- **Linter globals**: `browser` and `chrome` are declared as globals in `biome.json` — don't remove them.

## Testing

```bash
npm test                        # run all tests
node --check content-script.js  # syntax check only
```

Tests use Node's built-in `node:test` runner + `linkedom` for DOM simulation. No external test framework.
Test files: `test/prime-rank-shared.test.js`, `test/content-script-dom.test.js`, `test/background-sync.test.js`
