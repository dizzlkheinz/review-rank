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

## Claude Code automations (`.claude/`)

- **Hooks block some edits**: `.claude/hooks/guard.mjs` (PreToolUse) refuses edits to `*.zip` and `.env` — that's intentional, not a tool failure. `format.mjs` (PostToolUse) formats only the edited file; `verify.mjs` (Stop) runs `npm test` and blocks finishing on a failure.
- **Hook contract**: hooks read tool data as JSON on **stdin** (`tool_input.file_path`). There is no `CLAUDE_TOOL_INPUT_FILE_PATH` env var — using one silently expands to empty.
- **Skills**: `/package` builds the ZIP; `/submit` does the full release (bump → verify → package → AMO upload → tag). Both are user-invoked only.
- **Agents**: `extension-reviewer` (AMO policy), `privacy-guard` (enforces `data_collection: ["none"]`), `selector-drift-auditor` (Amazon DOM fragility + locale coverage).

## Gotchas

- **Firefox MV3 compat**: `manifest.json` lists both `background.scripts` (Firefox) and `background.service_worker` (Chrome). Keep both.
- **Shared module pattern**: `prime-rank-shared.js` uses a UMD IIFE that attaches to `globalThis.PrimeRankShared`. Import via `importScripts` in the service worker and via `<script>` in popup — not ES modules.
- **`amazon-brand-whitelist.js` is generated**: Do not hand-edit. It is excluded from Biome formatting in `biome.json`.
- **No host_permissions for Amazon domains**: Content scripts are declared in manifest; no broad host permissions needed. The only external request is to `raw.githubusercontent.com` (already in `host_permissions`).
- **Prime token**: Prime enforcement appends Amazon's own Prime refinement to the URL. The key differs per marketplace (`p_85` on `.ca`/`.com`, two OR-joined `p_n_prime_domestic` values on `.com.mx`), so `PRIME_TOKEN_KEYS` drives both the regexes and the DOM selectors. `PRIME_TOKEN_FALLBACKS` entries MUST be measured against the live marketplace first: a foreign or invalid token makes Amazon discard every sibling refinement (widening results). Tokens seen in a page are learned into `primeTokensByHost` for marketplaces with no bundled entry. The `enforcePrime` setting gates the whole path; off means the extension never adds the facet (it never strips one Amazon or the user applied).
- **Linter globals**: `browser` and `chrome` are declared as globals in `biome.json` — don't remove them.

## Testing

```bash
npm test                        # run all tests
node --check content-script.js  # syntax check only
```

Tests use Node's built-in `node:test` runner + `linkedom` for DOM simulation. No external test framework.
Test files: `test/prime-rank-shared.test.js`, `test/content-script-dom.test.js`, `test/background-sync.test.js`

## Publishing Updates

1. **Bump Version**: Increment `"version"` in [manifest.json](file:///C:/Users/ksutk/projects/review-rank/manifest.json) and [package.json](file:///C:/Users/ksutk/projects/review-rank/package.json).
2. **Package**: Run the PowerShell script to build the release ZIP:
   ```powershell
   $version = (Get-Content manifest.json | ConvertFrom-Json).version
   Compress-Archive -Path manifest.json, background.js, content-script.js, prime-rank-shared.js, amazon-brand-whitelist.js, popup.html, popup.js, popup.css, icons -DestinationPath "review-rank-$version.zip" -Force
   ```
3. **Submit to Mozilla**:
   - **Manual**: Upload the generated ZIP file to the [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/).
   - **CLI**: Authenticate using the keys in [.env](file:///C:/Users/ksutk/projects/review-rank/.env):
     ```powershell
     # Load keys from .env (PowerShell)
     $env:AMO_JWT_ISSUER = (Select-String -Path .env -Pattern "^AMO_JWT_ISSUER=\`"(.*)\`"").Matches.Groups[1].Value
     $env:AMO_JWT_SECRET = (Select-String -Path .env -Pattern "^AMO_JWT_SECRET=\`"(.*)\`"").Matches.Groups[1].Value
     
     # Submit
     npx web-ext submit --api-key=$env:AMO_JWT_ISSUER --api-secret=$env:AMO_JWT_SECRET
     ```

