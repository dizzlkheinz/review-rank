const test = require("node:test");
const assert = require("node:assert/strict");
const localeFixtures = require("./fixtures/amazon-locale-fixtures.json");
const urlCases = require("./fixtures/url-cases.json");
const shared = require("../prime-rank-shared.js");

test("sanitizeSettings preserves new sponsored toggle defaults", () => {
	assert.deepEqual(shared.sanitizeSettings({}), {
		enabled: true,
		minimumRatings: 100,
		useBrandWhitelist: false,
		hideSponsoredResults: true,
	});
});

test("locale rating fixtures parse review counts instead of star ratings", () => {
	for (const fixture of localeFixtures.ratings) {
		assert.equal(
			shared.parseRatingsCountFromTexts(fixture.candidates),
			fixture.expected,
			fixture.market,
		);
	}
});

test("locale brand fixtures match allowlisted brands", () => {
	for (const fixture of localeFixtures.brands) {
		const brandIndex = shared.buildBrandIndex(fixture.brands);

		assert.equal(
			shared.matchWhitelistedBrand(fixture.candidates, brandIndex),
			fixture.expected,
			fixture.market,
		);
	}
});

test("sponsored label matcher covers major locale variants", () => {
	for (const fixture of localeFixtures.sponsored) {
		assert.equal(
			shared.matchesSponsoredLabelText(fixture.text),
			fixture.expected,
			fixture.market,
		);
	}
});

test("buildCanonicalSearchUrl rewrites Amazon search urls deterministically", () => {
	for (const fixture of urlCases) {
		const result = shared.buildCanonicalSearchUrl(fixture.url, {
			primeToken: fixture.primeToken,
		});

		assert.equal(result.changed, fixture.changed, fixture.name);
		assert.equal(
			result.missingPrimeToken,
			fixture.missingPrimeToken,
			fixture.name,
		);

		for (const snippet of fixture.includes) {
			assert.match(result.url, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	}
});

test("extractPrimeTokensFromText deduplicates tokens", () => {
	assert.deepEqual(
		shared.extractPrimeTokensFromText(
			"rh=p_85:2470955011,p_85:2470955011&other=p_85:123",
		),
		["p_85:2470955011", "p_85:123"],
	);
});

test("parseBrandWhitelist removes blanks and duplicates", () => {
	assert.deepEqual(
		shared.parseBrandWhitelist("Apple\n\nSamsung\nApple\n"),
		["Apple", "Samsung"],
	);
});

test("shouldRefreshBrandWhitelist expires stale entries only", () => {
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: ["Apple"],
			brandWhitelistFetchedAt: 1_000,
			now: 1_000 + shared.BRAND_WHITELIST_MAX_AGE_MS - 1,
		}),
		false,
	);
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: ["Apple"],
			brandWhitelistFetchedAt: 1_000,
			now: 1_000 + shared.BRAND_WHITELIST_MAX_AGE_MS,
		}),
		true,
	);
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: [],
			brandWhitelistFetchedAt: 1_000,
			now: 2_000,
		}),
		true,
	);
});
