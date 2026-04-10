---
name: package
description: Build the Firefox addon ZIP for AMO submission, excluding dev files. Version is read automatically from manifest.json.
disable-model-invocation: true
---

Run this PowerShell command from the project root to produce the submission ZIP:

```powershell
$version = (Get-Content manifest.json | ConvertFrom-Json).version
Compress-Archive -Path manifest.json, background.js, content-script.js, prime-rank-shared.js, amazon-brand-whitelist.js, popup.html, popup.js, popup.css, icons -DestinationPath "prime-rank-filter-$version.zip" -Force
Write-Host "Built prime-rank-filter-$version.zip"
```

The ZIP name is derived from the `version` field in manifest.json automatically.
