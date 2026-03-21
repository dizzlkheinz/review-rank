# Manual Test Checklist

## Firefox Desktop

- Load the addon temporarily from `manifest.json`.
- Open an Amazon search URL on a supported domain and confirm the page redirects to a Prime-only, `review-rank` search when the filter is enabled.
- Open the popup from the toolbar and confirm current-page status updates without console errors.
- Enable `Hide sponsored results` and verify sponsored cards/modules disappear on a page like:
  `https://www.amazon.ca/s?k=litter+box&i=pets&rh=n%3A6205514011%2Cp_85%3A5690392011&s=review-rank`
- Change the minimum ratings threshold and confirm low-review products are hidden.
- Enable the brand whitelist and confirm non-allowlisted brands are hidden.
- Use the popup refresh action and confirm the whitelist metadata updates.

## Firefox Android

- Install the signed addon build on Firefox for Android.
- Open the addon controls from the browser extension settings and confirm the popup UI is usable there.
- Visit a supported Amazon domain and confirm Prime enforcement and sponsored hiding still apply on mobile result pages.

## Chrome

- Load the unpacked extension in `chrome://extensions`.
- Confirm the background service worker starts without errors.
- Open a supported Amazon search page and confirm Prime enforcement, sponsored hiding, minimum ratings, and whitelist filtering all work.
- Open the popup and confirm page status plus whitelist refresh still work under Chromium.

## Regression Checks

- Run `npm test`.
- Run `node --check content-script.js`.
- Confirm `manifest.json` parses as valid JSON.
