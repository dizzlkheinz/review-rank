const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");

const sharedSource = fs.readFileSync(
	path.join(__dirname, "..", "prime-rank-shared.js"),
	"utf-8",
);
const contentSource = fs.readFileSync(
	path.join(__dirname, "..", "content-script.js"),
	"utf-8",
);
const fixtureHtml = fs.readFileSync(
	path.join(__dirname, "fixtures", "search-results.html"),
	"utf-8",
);
const DEFAULT_TEST_URL =
	"https://www.amazon.com/s?k=headphones&s=review-rank&rh=p_85%3A2470955011";

function createTestWindow(html, url, replacedUrls) {
	const { document, window } = parseHTML(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
	);

	window.setTimeout = setTimeout;
	window.clearTimeout = clearTimeout;
	window.queueMicrotask = queueMicrotask;
	window.console = console;
	window.URL = URL;
	window.location = {
		href: url,
		replace(nextUrl) {
			replacedUrls.push(nextUrl);
			this.href = nextUrl;
		},
	};

	return { document, window };
}

function getStorageChanges(storageData, values) {
	const changes = {};

	for (const [key, value] of Object.entries(values)) {
		if (storageData[key] === value) {
			continue;
		}

		changes[key] = {
			oldValue: storageData[key],
			newValue: value,
		};
	}

	return changes;
}

function notifyStorageListeners(changes, storageChangeListeners) {
	if (Object.keys(changes).length === 0) {
		return;
	}

	for (const listener of storageChangeListeners) {
		listener(changes, "local");
	}
}

function createStorageApi(storageData, storageChangeListeners) {
	return {
		local: {
			get: async (defaults) => ({ ...defaults, ...storageData }),
			set: async (values) => {
				const changes = getStorageChanges(storageData, values);
				Object.assign(storageData, values);
				notifyStorageListeners(changes, storageChangeListeners);
			},
		},
		onChanged: {
			addListener: (listener) => {
				storageChangeListeners.push(listener);
			},
		},
	};
}

function createRuntimeApi(sentMessages, runtimeMessageListeners) {
	return {
		onMessage: {
			addListener: (listener) => {
				runtimeMessageListeners.push(listener);
			},
		},
		sendMessage: (msg) => {
			sentMessages.push(msg);
			return Promise.resolve();
		},
	};
}

function loadSharedApi() {
	const sharedGlobal = {
		globalThis: {},
		module: { exports: {} },
	};
	sharedGlobal.globalThis = sharedGlobal;

	const sharedFn = new Function("globalThis", "module", sharedSource);
	sharedFn(sharedGlobal, sharedGlobal.module);

	return sharedGlobal.PrimeRankShared;
}

function createTestEnv(options = {}) {
	const { html = fixtureHtml, storage = {}, url = DEFAULT_TEST_URL } = options;
	const storageData = { ...storage };
	const sentMessages = [];
	const runtimeMessageListeners = [];
	const storageChangeListeners = [];
	const replacedUrls = [];
	const { document, window } = createTestWindow(html, url, replacedUrls);
	const extensionApi = {
		storage: createStorageApi(storageData, storageChangeListeners),
		runtime: createRuntimeApi(sentMessages, runtimeMessageListeners),
	};

	return {
		document,
		window,
		shared: loadSharedApi(),
		extensionApi,
		storageData,
		sentMessages,
		runtimeMessageListeners,
		replacedUrls,
	};
}

// ---------------------------------------------------------------------------
// Helper: execute the shipped content script in the test DOM
// ---------------------------------------------------------------------------

function executeContentScript(env) {
	const contentGlobal = {
		browser: env.extensionApi,
		PrimeRankShared: env.shared,
	};
	contentGlobal.globalThis = contentGlobal;

	const contentFn = new Function(
		"globalThis",
		"window",
		"document",
		"Element",
		"MutationObserver",
		"URL",
		"queueMicrotask",
		"console",
		"setTimeout",
		"clearTimeout",
		contentSource,
	);

	contentFn(
		contentGlobal,
		env.window,
		env.document,
		env.window.Element,
		env.window.MutationObserver,
		URL,
		queueMicrotask,
		console,
		setTimeout,
		clearTimeout,
	);
}

function waitFor(ms = 0) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function runContentScript(options = {}) {
	const env = createTestEnv(options);
	executeContentScript(env);
	await waitFor(220);
	return env;
}

function normalizeSelectors(selectors) {
	return Array.isArray(selectors) ? selectors : [selectors];
}

function getNodeTextCandidate(node) {
	return (
		node.getAttribute("aria-label") ||
		node.getAttribute("data-ad-feedback") ||
		node.textContent ||
		""
	).trim();
}

function collectTextCandidates(root, selector, seen, values) {
	if (!selector) {
		return;
	}

	for (const node of root.querySelectorAll(selector)) {
		const text = getNodeTextCandidate(node);

		if (!text || seen.has(text)) {
			continue;
		}

		seen.add(text);
		values.push(text);
	}
}

function getTextCandidates(_document, root, selectors) {
	const seen = new Set();
	const values = [];

	for (const selector of normalizeSelectors(selectors)) {
		collectTextCandidates(root, selector, seen, values);
	}

	return values;
}

const RATING_TEXT_SELECTORS = [
	"a[href*='customerReviews'] .s-underline-text",
	"a[href*='customerReviews'] span[aria-hidden='true']",
	"a[href*='customerReviews'] span",
	"a[href*='customerReviews']",
	"[data-cy='reviews-block'] span",
	"[data-cy='reviews-ratings-slot'] span",
];

const BRAND_TEXT_SELECTORS = [
	"[data-cy='title-recipe'] h2 a span",
	"[data-cy='title-recipe'] h2 span",
	"h2.a-size-mini a span",
	"h2 a span",
];

const SPONSORED_STRUCTURAL_SELECTOR = [
	"[data-component-type='sp-sponsored-result']",
	"[data-cel-widget^='sp_']",
	"[data-cel-widget*='sp-sponsored']",
	"[data-ad-feedback]",
	"[data-ad-details]",
	"[data-ad-id]",
	"[id^='sp_']",
	".puis-sponsored-label-text",
	".s-sponsored-label-text",
	".puis-label-popover",
	".s-label-popover",
	".s-label-popover-hover",
].join(", ");

const RESULT_CARD_SELECTOR =
	"div[data-component-type='s-search-result'][data-asin]";

// ---------------------------------------------------------------------------
// Tests: DOM-based card detection
// ---------------------------------------------------------------------------

test("fixture contains expected number of search result cards", () => {
	const { document } = createTestEnv();
	const cards = document.querySelectorAll(RESULT_CARD_SELECTOR);
	assert.equal(cards.length, 6);
});

test("finds results container via s-main-slot selector", () => {
	const { document } = createTestEnv();
	const container = document.querySelector("div.s-main-slot.s-result-list");
	assert.ok(container, "results container should exist");
});

// ---------------------------------------------------------------------------
// Tests: Rating parsing from DOM
// ---------------------------------------------------------------------------

test("parses high rating count from card 1 (Samsung)", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST01']");
	const texts = getTextCandidates(document, card, RATING_TEXT_SELECTORS);
	const count = shared.parseRatingsCountFromTexts(texts);
	assert.equal(count, 12345);
});

test("parses low rating count from card 2 (NoName)", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST02']");
	const texts = getTextCandidates(document, card, RATING_TEXT_SELECTORS);
	const count = shared.parseRatingsCountFromTexts(texts);
	assert.equal(count, 42);
});

test("returns 0 ratings for card with no reviews block", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST05']");
	const texts = getTextCandidates(document, card, RATING_TEXT_SELECTORS);
	const count = shared.parseRatingsCountFromTexts(texts);
	assert.equal(count, 0);
});

// ---------------------------------------------------------------------------
// Tests: Sponsored detection from DOM
// ---------------------------------------------------------------------------

test("detects card 3 as sponsored via structural selector (sp-sponsored-result parent)", () => {
	const { document } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST03']");
	const parent = card.closest("[data-component-type='sp-sponsored-result']");
	assert.ok(parent, "card 3 should have sp-sponsored-result ancestor");
});

test("detects card 4 as sponsored via data-ad-feedback attribute", () => {
	const { document } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST04']");
	assert.ok(
		card.matches("[data-ad-feedback]"),
		"card 4 should have data-ad-feedback",
	);
});

test("card 1 (Samsung) is not sponsored", () => {
	const { document } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST01']");
	const isSponsored =
		card.matches(SPONSORED_STRUCTURAL_SELECTOR) ||
		Boolean(card.querySelector(SPONSORED_STRUCTURAL_SELECTOR));
	assert.equal(isSponsored, false);
});

// ---------------------------------------------------------------------------
// Tests: Brand matching from DOM text
// ---------------------------------------------------------------------------

test("extracts brand text from card title", () => {
	const { document } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST01']");
	const texts = getTextCandidates(document, card, BRAND_TEXT_SELECTORS);
	assert.ok(texts.some((t) => t.includes("Samsung")));
});

test("brand whitelist matches Samsung from card DOM text", () => {
	const { document, shared } = createTestEnv();
	const brandIndex = shared.buildBrandIndex(["Samsung", "Apple", "Sony"]);
	const card = document.querySelector("[data-asin='B000TEST01']");
	const texts = getTextCandidates(document, card, BRAND_TEXT_SELECTORS);
	const match = shared.matchWhitelistedBrand(texts, brandIndex);
	assert.equal(match, "Samsung");
});

test("brand whitelist returns empty for non-whitelisted brand", () => {
	const { document, shared } = createTestEnv();
	const brandIndex = shared.buildBrandIndex(["Apple", "Sony"]);
	const card = document.querySelector("[data-asin='B000TEST02']");
	const texts = getTextCandidates(document, card, BRAND_TEXT_SELECTORS);
	const match = shared.matchWhitelistedBrand(texts, brandIndex);
	assert.equal(match, "");
});

// ---------------------------------------------------------------------------
// Tests: Card filtering logic (evaluateCard equivalent)
// ---------------------------------------------------------------------------

function getCardRatingsCount(document, shared, card) {
	const ratingsTexts = getTextCandidates(document, card, RATING_TEXT_SELECTORS);
	return shared.parseRatingsCountFromTexts(ratingsTexts);
}

function getBrandIndex(shared, settings, brandWhitelist) {
	const normalizedWhitelist = shared.normalizeBrandWhitelist(brandWhitelist);

	return settings.useBrandWhitelist && normalizedWhitelist.length
		? shared.buildBrandIndex(normalizedWhitelist)
		: null;
}

function getMatchedBrand(document, shared, card, settings, brandIndex) {
	const brandTexts = getTextCandidates(document, card, BRAND_TEXT_SELECTORS);

	return settings.useBrandWhitelist && brandIndex
		? shared.matchWhitelistedBrand(brandTexts, brandIndex)
		: "";
}

function isSponsoredTestCard(card, settings) {
	return (
		settings.hideSponsoredResults &&
		(card.matches(SPONSORED_STRUCTURAL_SELECTOR) ||
			Boolean(card.querySelector(SPONSORED_STRUCTURAL_SELECTOR)) ||
			Boolean(card.closest("[data-component-type='sp-sponsored-result']")))
	);
}

function getHiddenReasons(
	settings,
	ratingsCount,
	sponsored,
	brandIndex,
	matchedBrand,
) {
	const hiddenReasons = [];

	if (settings.hideSponsoredResults && sponsored) {
		hiddenReasons.push("sponsored");
	}

	if (ratingsCount < settings.minimumRatings) {
		hiddenReasons.push("low-reviews");
	}

	if (settings.useBrandWhitelist && brandIndex && !matchedBrand) {
		hiddenReasons.push("brand");
	}

	return hiddenReasons;
}

function evaluateCard(document, shared, card, settings, brandWhitelist = []) {
	const resolvedSettings = shared.sanitizeSettings(settings);
	const ratingsCount = getCardRatingsCount(document, shared, card);
	const brandIndex = getBrandIndex(shared, resolvedSettings, brandWhitelist);
	const matchedBrand = getMatchedBrand(
		document,
		shared,
		card,
		resolvedSettings,
		brandIndex,
	);
	const sponsored = isSponsoredTestCard(card, resolvedSettings);
	const hiddenReasons = getHiddenReasons(
		resolvedSettings,
		ratingsCount,
		sponsored,
		brandIndex,
		matchedBrand,
	);

	return {
		keep: hiddenReasons.length === 0,
		hiddenReasons,
		ratingsCount,
		matchedBrand,
		sponsored,
	};
}

test("card 1 (Samsung, 12345 reviews) passes default filters", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST01']");
	const result = evaluateCard(document, shared, card, {
		minimumRatings: 100,
		hideSponsoredResults: true,
	});
	assert.equal(result.keep, true);
	assert.equal(result.ratingsCount, 12345);
});

test("card 2 (42 reviews) hidden by minimumRatings=100", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST02']");
	const result = evaluateCard(document, shared, card, { minimumRatings: 100 });
	assert.equal(result.keep, false);
	assert.ok(result.hiddenReasons.includes("low-reviews"));
});

test("card 2 passes when minimumRatings=0", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST02']");
	const result = evaluateCard(document, shared, card, { minimumRatings: 0 });
	assert.equal(result.keep, true);
});

test("card 3 (sponsored) is hidden when hideSponsoredResults=true", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST03']");
	const result = evaluateCard(document, shared, card, {
		minimumRatings: 0,
		hideSponsoredResults: true,
	});
	assert.equal(result.keep, false);
	assert.ok(result.hiddenReasons.includes("sponsored"));
});

test("card 3 passes when hideSponsoredResults=false", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST03']");
	const result = evaluateCard(document, shared, card, {
		minimumRatings: 0,
		hideSponsoredResults: false,
	});
	assert.equal(result.keep, true);
});

test("card 5 (no reviews) hidden by minimumRatings=100", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST05']");
	const result = evaluateCard(document, shared, card, { minimumRatings: 100 });
	assert.equal(result.keep, false);
	assert.ok(result.hiddenReasons.includes("low-reviews"));
});

test("brand whitelist hides non-whitelisted product from DOM", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST02']");
	const result = evaluateCard(
		document,
		shared,
		card,
		{ minimumRatings: 0, useBrandWhitelist: true },
		["Samsung", "Apple", "Sony"],
	);
	assert.equal(result.keep, false);
	assert.ok(result.hiddenReasons.includes("brand"));
});

test("brand whitelist allows whitelisted product from DOM", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST01']");
	const result = evaluateCard(
		document,
		shared,
		card,
		{ minimumRatings: 0, useBrandWhitelist: true },
		["Samsung", "Apple", "Sony"],
	);
	assert.equal(result.keep, true);
	assert.equal(result.matchedBrand, "Samsung");
});

// ---------------------------------------------------------------------------
// Tests: Empty whitelist fails open (Issue #1)
// ---------------------------------------------------------------------------

test("empty brand whitelist does NOT hide products (fail-open)", () => {
	const { document, shared } = createTestEnv();
	const card = document.querySelector("[data-asin='B000TEST01']");
	const result = evaluateCard(
		document,
		shared,
		card,
		{ minimumRatings: 0, useBrandWhitelist: true },
		[],
	);
	assert.equal(result.keep, true, "should fail open when whitelist is empty");
	assert.ok(
		!result.hiddenReasons.includes("brand"),
		"should not add brand to hidden reasons with empty whitelist",
	);
});

// ---------------------------------------------------------------------------
// Tests: Unicode brand normalization (Issue #12)
// ---------------------------------------------------------------------------

test("normalizeBrandText preserves CJK characters", () => {
	const { shared } = createTestEnv();
	const result = shared.normalizeBrandText("Sony ソニー");
	assert.ok(
		result.includes("ソニー"),
		`expected CJK chars preserved, got: ${result}`,
	);
});

test("normalizeBrandText preserves Arabic characters", () => {
	const { shared } = createTestEnv();
	const result = shared.normalizeBrandText("Samsung سامسونج");
	assert.ok(
		result.includes("سامسونج"),
		`expected Arabic chars preserved, got: ${result}`,
	);
});

test("normalizeBrandText preserves Cyrillic characters", () => {
	const { shared } = createTestEnv();
	const result = shared.normalizeBrandText("Яндекс");
	assert.ok(
		result.includes("яндекс"),
		`expected Cyrillic chars preserved, got: ${result}`,
	);
});

// ---------------------------------------------------------------------------
// Tests: Sponsored label text detection (multi-locale)
// ---------------------------------------------------------------------------

test("matchesSponsoredLabelText detects Turkish 'sponsorlu'", () => {
	const { shared } = createTestEnv();
	assert.equal(shared.matchesSponsoredLabelText("Sponsorlu"), true);
});

test("matchesSponsoredLabelText detects Chinese '广告'", () => {
	const { shared } = createTestEnv();
	assert.equal(shared.matchesSponsoredLabelText("广告"), true);
});

test("matchesSponsoredLabelText detects Arabic 'ممول'", () => {
	const { shared } = createTestEnv();
	assert.equal(shared.matchesSponsoredLabelText("ممول"), true);
});

test("matchesSponsoredLabelText detects Korean '스폰서'", () => {
	const { shared } = createTestEnv();
	assert.equal(shared.matchesSponsoredLabelText("스폰서"), true);
});

test("matchesSponsoredLabelText returns false for unrelated text", () => {
	const { shared } = createTestEnv();
	assert.equal(shared.matchesSponsoredLabelText("Just a product title"), false);
});

// ---------------------------------------------------------------------------
// Integration tests: execute the real content script
// ---------------------------------------------------------------------------

test("content script applies filters when results load after init", async () => {
	const env = await runContentScript({ html: "" });

	assert.equal(env.document.querySelector("[data-asin]"), null);

	env.document.body.innerHTML = fixtureHtml;
	await waitFor(250);

	const lateCard = env.document.querySelector("[data-asin='B000TEST02']");
	assert.ok(lateCard, "late-loaded result card should exist");
	assert.equal(
		lateCard.dataset.primeRankFilter,
		"hidden",
		"late-loaded low-review card should be filtered",
	);
	assert.equal(lateCard.getAttribute("aria-hidden"), "true");
});

test("content script re-evaluates a card when a sponsored href is added", async () => {
	const env = await runContentScript();
	const card = env.document.querySelector("[data-asin='B000TEST01']");
	const productLink = card.querySelector("h2 a");

	assert.equal(card.dataset.primeRankFilter, "visible");

	productLink.setAttribute(
		"href",
		"https://aax-us-east.amazon.com/x/c/some-tracking-id",
	);
	await waitFor(250);

	assert.equal(
		card.dataset.primeRankFilter,
		"hidden",
		"href mutation should trigger sponsored re-evaluation",
	);
	assert.ok(card.dataset.primeRankHiddenReasons.includes("sponsored"));
});

test("content script re-evaluates a card when aria-label becomes sponsored", async () => {
	const env = await runContentScript();
	const card = env.document.querySelector("[data-asin='B000TEST01']");

	assert.equal(card.dataset.primeRankFilter, "visible");

	card.setAttribute("aria-label", "Sponsored Ad");
	await waitFor(250);

	assert.equal(
		card.dataset.primeRankFilter,
		"hidden",
		"aria-label mutation should trigger sponsored re-evaluation",
	);
	assert.ok(card.dataset.primeRankHiddenReasons.includes("sponsored"));
});
