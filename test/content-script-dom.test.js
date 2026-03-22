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

function createTestEnv(options = {}) {
	const { document, window } = parseHTML(
		`<!DOCTYPE html><html><body>${fixtureHtml}</body></html>`,
	);

	const storageData = {};
	const sentMessages = [];

	const extensionApi = {
		storage: {
			local: {
				get: async (defaults) => ({ ...defaults, ...storageData }),
				set: async (values) => Object.assign(storageData, values),
			},
			onChanged: { addListener: () => {} },
		},
		runtime: {
			onMessage: { addListener: () => {} },
			sendMessage: (msg) => {
				sentMessages.push(msg);
				return Promise.resolve();
			},
		},
	};

	// Execute shared module in a fresh scope
	const sharedGlobal = {
		globalThis: {},
		module: { exports: {} },
	};
	sharedGlobal.globalThis = sharedGlobal;

	const sharedFn = new Function("globalThis", "module", sharedSource);
	sharedFn(sharedGlobal, sharedGlobal.module);

	const shared = sharedGlobal.PrimeRankShared;

	return { document, window, shared, extensionApi, storageData, sentMessages };
}

// ---------------------------------------------------------------------------
// Helper: run content-script functions in isolation using shared module
// ---------------------------------------------------------------------------

function buildFilterEnv(settings = {}, brandWhitelist = []) {
	const env = createTestEnv();
	const { shared, document } = env;
	const resolvedSettings = shared.sanitizeSettings(settings);
	const normalizedWhitelist = shared.normalizeBrandWhitelist(brandWhitelist);
	const brandIndex =
		resolvedSettings.useBrandWhitelist && normalizedWhitelist.length
			? shared.buildBrandIndex(normalizedWhitelist)
			: null;

	return { ...env, resolvedSettings, brandIndex };
}

function getTextCandidates(document, root, selectors) {
	const seen = new Set();
	const values = [];
	const normalizedSelectors = Array.isArray(selectors)
		? selectors
		: [selectors];

	for (const selector of normalizedSelectors) {
		if (!selector) continue;
		const nodes = root.querySelectorAll(selector);
		for (const node of nodes) {
			const text = (
				node.getAttribute("aria-label") ||
				node.getAttribute("data-ad-feedback") ||
				node.textContent ||
				""
			).trim();
			if (!text || seen.has(text)) continue;
			seen.add(text);
			values.push(text);
		}
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

function evaluateCard(document, shared, card, settings, brandWhitelist = []) {
	const resolvedSettings = shared.sanitizeSettings(settings);
	const ratingsTexts = getTextCandidates(document, card, RATING_TEXT_SELECTORS);
	const ratingsCount = shared.parseRatingsCountFromTexts(ratingsTexts);

	const normalizedWhitelist = shared.normalizeBrandWhitelist(brandWhitelist);
	const brandIndex =
		resolvedSettings.useBrandWhitelist && normalizedWhitelist.length
			? shared.buildBrandIndex(normalizedWhitelist)
			: null;

	const brandTexts = getTextCandidates(document, card, BRAND_TEXT_SELECTORS);
	const matchedBrand =
		resolvedSettings.useBrandWhitelist && brandIndex
			? shared.matchWhitelistedBrand(brandTexts, brandIndex)
			: "";

	// Simplified sponsored check
	const sponsored =
		resolvedSettings.hideSponsoredResults &&
		(card.matches(SPONSORED_STRUCTURAL_SELECTOR) ||
			Boolean(card.querySelector(SPONSORED_STRUCTURAL_SELECTOR)) ||
			Boolean(card.closest("[data-component-type='sp-sponsored-result']")));

	const hiddenReasons = [];

	if (resolvedSettings.hideSponsoredResults && sponsored) {
		hiddenReasons.push("sponsored");
	}

	if (ratingsCount < resolvedSettings.minimumRatings) {
		hiddenReasons.push("low-reviews");
	}

	if (resolvedSettings.useBrandWhitelist && brandIndex && !matchedBrand) {
		hiddenReasons.push("brand");
	}

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
