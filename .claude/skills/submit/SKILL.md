---
name: submit
description: Bump the version, verify, package, and submit the extension to addons.mozilla.org via web-ext. Publishes publicly — user-invoked only.
disable-model-invocation: true
---

Full release path for Review Rank. Stop and report if any step fails; do not continue past a failure.

Ask which part to bump (patch/minor/major) if the user did not say.

### 1. Preflight

```powershell
$m = (Get-Content manifest.json | ConvertFrom-Json).version
$p = (Get-Content package.json | ConvertFrom-Json).version
if ($m -ne $p) { throw "Version mismatch: manifest.json=$m package.json=$p" }
Write-Host "Current version: $m"
git status --short
```

A dirty working tree of tracked files is a stop — commit first.

### 2. Bump both files

Increment `"version"` in **both** `manifest.json` and `package.json`. They must stay identical; AMO reads the manifest, and a mismatch is invisible until you are debugging a release.

### 3. Verify

```powershell
npm run verify
```

Lint plus tests. Do not submit on a failure.

Also run the `extension-reviewer` and `privacy-guard` agents at this point — they check AMO policy compliance and the `data_collection: ["none"]` claim respectively.

### 4. Package

Use the `/package` skill, or inline:

```powershell
$version = (Get-Content manifest.json | ConvertFrom-Json).version
Compress-Archive -Path manifest.json, background.js, content-script.js, prime-rank-shared.js, amazon-brand-whitelist.js, popup.html, popup.js, popup.css, icons -DestinationPath "review-rank-$version.zip" -Force
```

### 5. Submit

This uploads publicly to addons.mozilla.org. **Confirm with the user before running it.**

```powershell
$env:AMO_JWT_ISSUER = (Select-String -Path .env -Pattern "^AMO_JWT_ISSUER=`"(.*)`"").Matches.Groups[1].Value
$env:AMO_JWT_SECRET = (Select-String -Path .env -Pattern "^AMO_JWT_SECRET=`"(.*)`"").Matches.Groups[1].Value
npx web-ext sign --api-key=$env:AMO_JWT_ISSUER --api-secret=$env:AMO_JWT_SECRET --channel=listed
```

Never echo the key values into the transcript.

### 6. Tag

```powershell
$version = (Get-Content manifest.json | ConvertFrom-Json).version
git commit -am "Bump release version to $version"
git tag "v$version"
```

Leave pushing to the user unless they ask.
