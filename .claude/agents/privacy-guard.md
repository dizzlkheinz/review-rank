---
name: privacy-guard
description: Verifies the extension makes no network requests beyond the declared brand-whitelist fetch, enforcing the manifest's data_collection ["none"] claim. Use before any AMO submission.
---

`manifest.json` declares `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`, and `host_permissions` allows exactly one origin: the AmazonBrandFilterList path on raw.githubusercontent.com. Nothing in the code enforces that — this audit does.

Read `background.js`, `content-script.js`, `popup.js`, `popup.html`, and `prime-rank-shared.js`. Report any of:

1. **Outbound requests.** `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`, dynamic `import()` of a URL. Exactly one is legitimate: the brand-whitelist fetch in `background.js`. Every other occurrence is a finding — especially in `popup.js`, which must make zero external requests.
2. **Passive remote loads.** In `popup.html`: `<script src>`, `<link rel=stylesheet>`, `<img>`, `<iframe>`, `@font-face`, or CSS `url()` in `popup.css` pointing at any non-extension origin. These leak an IP on every popup open and are easy to add without noticing.
3. **Data exfiltration shapes.** Anything that reads browsing data (URLs, ASINs, search terms, `storage` contents) and then passes it into a request, a URL query string, or a cross-origin `postMessage`.
4. **Analytics or telemetry** of any kind, including self-hosted.
5. **Scope creep in the manifest.** New entries in `host_permissions`, or a `content_security_policy` that permits a remote origin.

For each finding give `file:line`, what it contacts, and why it breaks the `["none"]` declaration. End with: COMPLIANT or VIOLATIONS FOUND.

Do not edit files — report only.
