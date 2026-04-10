const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../prime-rank-shared.js");

// ---------------------------------------------------------------------------
// 1. Whitelist normalization edge cases
// ---------------------------------------------------------------------------

test("normalizeBrandWhitelist returns empty array for empty input", () => {
	assert.deepEqual(shared.normalizeBrandWhitelist([]), []);
});

test("normalizeBrandWhitelist strips nulls, undefined, and empty strings", () => {
	assert.deepEqual(
		shared.normalizeBrandWhitelist([null, undefined, "", "Apple"]),
		["Apple"],
	);
});

test("normalizeBrandWhitelist deduplicates brands", () => {
	assert.deepEqual(
		shared.normalizeBrandWhitelist(["Apple", "Samsung", "Apple"]),
		["Apple", "Samsung"],
	);
});

test("normalizeBrandWhitelist removes whitespace-only brands", () => {
	assert.deepEqual(
		shared.normalizeBrandWhitelist(["  ", "\t", " \n ", "Sony"]),
		["Sony"],
	);
});

test("normalizeBrandWhitelist returns empty array for non-array input", () => {
	assert.deepEqual(shared.normalizeBrandWhitelist("not an array"), []);
	assert.deepEqual(shared.normalizeBrandWhitelist(null), []);
	assert.deepEqual(shared.normalizeBrandWhitelist(undefined), []);
});

// ---------------------------------------------------------------------------
// 2. shouldRefreshBrandWhitelist logic
// ---------------------------------------------------------------------------

test("shouldRefreshBrandWhitelist returns false for fresh whitelist", () => {
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: ["Apple"],
			brandWhitelistFetchedAt: 10_000,
			now: 10_000 + shared.BRAND_WHITELIST_MAX_AGE_MS - 1,
		}),
		false,
	);
});

test("shouldRefreshBrandWhitelist returns true for stale whitelist", () => {
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: ["Apple"],
			brandWhitelistFetchedAt: 10_000,
			now: 10_000 + shared.BRAND_WHITELIST_MAX_AGE_MS + 1,
		}),
		true,
	);
});

test("shouldRefreshBrandWhitelist returns true for empty whitelist regardless of age", () => {
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: [],
			brandWhitelistFetchedAt: Date.now(),
			now: Date.now(),
		}),
		true,
	);
});

test("shouldRefreshBrandWhitelist returns true at exact boundary", () => {
	assert.equal(
		shared.shouldRefreshBrandWhitelist({
			brandWhitelist: ["Apple"],
			brandWhitelistFetchedAt: 5_000,
			now: 5_000 + shared.BRAND_WHITELIST_MAX_AGE_MS,
		}),
		true,
	);
});

// ---------------------------------------------------------------------------
// 3. parseBrandWhitelist edge cases
// ---------------------------------------------------------------------------

test("parseBrandWhitelist returns empty array for empty string", () => {
	assert.deepEqual(shared.parseBrandWhitelist(""), []);
});

test("parseBrandWhitelist returns empty array for only newlines", () => {
	assert.deepEqual(shared.parseBrandWhitelist("\n\n\n"), []);
});

test("parseBrandWhitelist handles Windows line endings", () => {
	assert.deepEqual(shared.parseBrandWhitelist("Apple\r\nSamsung\r\nSony"), [
		"Apple",
		"Samsung",
		"Sony",
	]);
});

test("parseBrandWhitelist trims leading and trailing whitespace from brands", () => {
	assert.deepEqual(
		shared.parseBrandWhitelist("  Apple  \n  Samsung  \n  Sony  "),
		["Apple", "Samsung", "Sony"],
	);
});

// ---------------------------------------------------------------------------
// 4. buildCanonicalSearchUrl additional cases
// ---------------------------------------------------------------------------

test("buildCanonicalSearchUrl makes no change when already canonical", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.com/s?k=test&s=review-rank&rh=p_85%3A2470955011",
		{ primeToken: "p_85:2470955011" },
	);

	assert.equal(result.changed, false);
	assert.equal(result.missingPrimeToken, false);
});

test("buildCanonicalSearchUrl handles URL with no search params", () => {
	const result = shared.buildCanonicalSearchUrl("https://www.amazon.com/s", {
		primeToken: "p_85:2470955011",
	});

	assert.equal(result.changed, true);
	assert.match(result.url, /s=review-rank/);
	assert.match(result.url, /rh=p_85%3A2470955011/);
});

test("buildCanonicalSearchUrl adds prime token to existing rh param", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.com/s?k=test&s=review-rank&rh=n%3A172541",
		{ primeToken: "p_85:2470955011" },
	);

	assert.equal(result.changed, true);
	assert.match(result.url, /p_85%3A2470955011/);
	assert.match(result.url, /n%3A172541/);
});

test("buildCanonicalSearchUrl does not duplicate existing prime token in rh", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.com/s?k=test&rh=p_85%3A2470955011",
		{ primeToken: "p_85:2470955011" },
	);

	// The existing prime token is preserved; primeToken option should not add a duplicate
	assert.equal(result.missingPrimeToken, false);
	const rhMatches = result.url.match(/p_85%3A2470955011/g);
	assert.equal(rhMatches.length, 1, "prime token should appear exactly once");
});

// ---------------------------------------------------------------------------
// 5. Brand matching edge cases
// ---------------------------------------------------------------------------

test("brand with special characters (ampersand) matches correctly", () => {
	const brandIndex = shared.buildBrandIndex(["Procter & Gamble"]);

	assert.equal(
		shared.matchWhitelistedBrand(["Procter & Gamble Laundry"], brandIndex),
		"Procter & Gamble",
	);
});

test("brand with apostrophes matches correctly", () => {
	const brandIndex = shared.buildBrandIndex(["L'Oreal Paris"]);

	assert.equal(
		shared.matchWhitelistedBrand(["L'Oreal Paris Mascara Volume"], brandIndex),
		"L'Oreal Paris",
	);
});

test("brand matching treats straight and curly apostrophes as equivalent", () => {
	const brandIndex = shared.buildBrandIndex(["L’Oréal Paris"]);

	assert.equal(
		shared.matchWhitelistedBrand(["L'Oreal Paris Mascara Volume"], brandIndex),
		"L’Oréal Paris",
	);
});

test("brand with accented characters matches via normalization", () => {
	const brandIndex = shared.buildBrandIndex(["Nestlé"]);

	assert.equal(
		shared.matchWhitelistedBrand(["Nestle Coffee"], brandIndex),
		"Nestlé",
	);
});

test("empty candidates array returns empty string", () => {
	const brandIndex = shared.buildBrandIndex(["Apple"]);

	assert.equal(shared.matchWhitelistedBrand([], brandIndex), "");
});

test("candidate that is a prefix of a brand but not a full match returns empty", () => {
	const brandIndex = shared.buildBrandIndex(["Apple Computers"]);

	// "Apple" alone should not match "Apple Computers" since the candidate is
	// shorter than the brand. The brand index checks if the candidate starts
	// with the brand, not the other way around.
	assert.equal(
		shared.matchWhitelistedBrand(["Apple"], brandIndex),
		"",
		"partial prefix of brand should not match",
	);
});

// ---------------------------------------------------------------------------
// 6. Rating count parsing edge cases
// ---------------------------------------------------------------------------

test("parses combined star rating and count text", () => {
	assert.equal(
		shared.parseRatingsCountFromTexts(["4.5 out of 5 stars, 1,234 ratings"]),
		1234,
	);
});

test("parses German-locale thousands separator (dot as separator)", () => {
	// In DE locale, "1.234 Bewertungen" means 1234 ratings
	assert.equal(shared.parseRatingsCountFromTexts(["1.234 Bewertungen"]), 1234);
});

test("returns 0 for text with no numbers", () => {
	assert.equal(shared.parseRatingsCountFromTexts(["no numbers here"]), 0);
});

test("returns 0 for text with only a decimal rating", () => {
	// "4.5" alone is a decimal rating <= 5, so it's not a count
	assert.equal(shared.parseRatingsCountFromTexts(["4.5"]), 0);
});

test("returns 0 for empty candidates array", () => {
	assert.equal(shared.parseRatingsCountFromTexts([]), 0);
});

test("returns 0 for candidates with empty strings", () => {
	assert.equal(shared.parseRatingsCountFromTexts(["", ""]), 0);
});
