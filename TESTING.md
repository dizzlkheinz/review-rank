# Manual Test Checklist

## Firefox Desktop

- Load the addon temporarily from `manifest.json`.
- Open an Amazon search URL on a supported domain and confirm the page redirects to a Prime-only, `review-rank` search when the filter is enabled.
- Open the popup from the toolbar and confirm current-page status updates without console errors.
- Enable `Hide sponsored results` and verify sponsored cards/modules disappear on a page like:
  `https://www.amazon.ca/s?k=litter+box&i=pets&rh=n%3A6205514011%2Cp_85%3A5690392011&s=review-rank`
- Open a seller-filtered page where Amazon hides its Prime facet and confirm the extension still appends it:
  `https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank`
  (86 results without the facet, 3 with it; the category and seller refinements must survive).
- Turn `Prime results only` off, confirm the page auto-reloads to keep the seller refinement without a Prime facet, and the popup reports `Prime-only filtering off.`
- With `Prime results only` still off, select Prime on Amazon and confirm the selection survives navigation and changes to the minimum review count.
- Change the minimum ratings threshold and confirm low-review products are hidden.
- Enable the brand whitelist and confirm non-allowlisted brands are hidden.
- Use the popup refresh action and confirm the whitelist metadata updates.
- On a search that loads results asynchronously, confirm Prime enforcement and review-rank sorting still apply after the first cards appear.
- Confirm sponsored banners outside the main result list disappear, including banners inserted after page load. Turn sponsored blocking off and back on to check restoration.
- Confirm an organic product with “Unsponsored” or “Sponsored” in its title stays visible when it has no advertisement labels or metadata.
- Where review counts are abbreviated (for example, `1.2K`), set a threshold below and above the displayed count and confirm filtering follows the count.

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
- Automated regressions exercise the shipped content and background scripts with simulated DOM, storage, alarms, and network responses; they do not replace the browser checks above.
- Run `node --check content-script.js`.
- Confirm `manifest.json` parses as valid JSON.
