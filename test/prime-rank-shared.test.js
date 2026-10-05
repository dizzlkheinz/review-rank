const test = require("node:test");
const assert = require("node:assert/strict");
const localeFixtures = require("./fixtures/amazon-locale-fixtures.json");
const urlCases = require("./fixtures/url-cases.json");
const shared = require("../prime-rank-shared.js");

test("sanitizeSettings preserves new sponsored toggle defaults", () => {
	assert.deepEqual(shared.sanitizeSettings({}), {
		enabled: true,
		enforcePrime: true,
		minimumRatings: 100,
		useBrandWhitelist: false,
		hideSponsoredResults: true,
	});
});

test("sanitizeSettings keeps an explicit enforcePrime opt-out", () => {
	assert.equal(
		shared.sanitizeSettings({ enforcePrime: false }).enforcePrime,
		false,
	);
	assert.equal(
		shared.sanitizeSettings({ enforcePrime: "no" }).enforcePrime,
		true,
	);
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

test("abbreviated review counts handle decimal separators and locale suffixes", () => {
	const cases = [
		["1K", 1_000],
		["1.2K ratings", 1_200],
		["12.3K reviews", 12_300],
		["4.7 out of 5 stars · 1,2K ratings", 1_200],
		["1,2 Tsd. Bewertungen", 1_200],
		["1,2 mil opiniones", 1_200],
		["1.2M reviews", 1_200_000],
	];

	for (const [text, expected] of cases) {
		assert.equal(shared.parseRatingsCountFromTexts([text]), expected, text);
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

test("sponsored label matcher handles fuzzy obfuscated cases", () => {
	const positiveCases = [
		"S p o n s o r e d",
		"G e s p o n s e r t",
		"S\u200Bponsored",
		"Ges\u200Cponsert",
		"Sponsor\u00adisé",
		"S  P  O  N  S  O  R  E  D",
	];

	const negativeCases = ["Sponsor shirt", "Top Brand", "Normal brand"];

	for (const text of positiveCases) {
		assert.equal(
			shared.matchesSponsoredLabelText(text),
			true,
			`Failed positive: ${text}`,
		);
	}

	for (const text of negativeCases) {
		assert.equal(
			shared.matchesSponsoredLabelText(text),
			false,
			`Failed negative: ${text}`,
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
			assert.match(
				result.url,
				new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
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

test("extractPrimeTokensFromText reads percent-encoded refinement hrefs", () => {
	assert.deepEqual(
		shared.extractPrimeTokensFromText(
			"/s?k=goartea&rh=n%3A6967215011%2Cp_85%3A5690392011&ref=sr_nr_p_85_1",
		),
		["p_85:5690392011"],
	);
	assert.deepEqual(
		shared.extractPrimeTokensFromText(
			"/s?k=ink&rh=p_n_prime_domestic%3A217698801011%7C217698802011",
		),
		["p_n_prime_domestic:217698801011|217698802011"],
	);
	assert.deepEqual(
		shared.extractPrimeTokensFromText(
			"/s?k=ink&rh=p_n_prime_domestic%253A217698801011%257C217698802011",
		),
		["p_n_prime_domestic:217698801011|217698802011"],
		"amazon.com.mx re-encodes its own refinement separator",
	);
	assert.deepEqual(
		shared.extractPrimeTokensFromText("rh=p_72%3A1234%2Cp_6%3AA2HMM5KJS65BH3"),
		[],
	);
});

test("extractPrimeTokensFromText decodes encoded refinement delimiters", () => {
	assert.deepEqual(
		shared.extractPrimeTokensFromText("/s?rh=p_85%3A123%2Cn%3A456&p=2"),
		["p_85:123"],
	);
	assert.deepEqual(
		shared.extractPrimeTokensFromText("/s?rh=p_85%253A123%252Cn%253A456"),
		["p_85:123"],
		"double-encoded refinement delimiters remain discoverable",
	);
});

test("buildCanonicalSearchUrl adds no prime token when enforcement is off", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.ca/s?k=goartea&rh=n%3A6967215011",
		{ primeToken: "p_85:5690392011", enforcePrime: false },
	);

	assert.equal(result.changed, true, "sort refinement is still applied");
	assert.match(result.url, /s=review-rank/);
	assert.doesNotMatch(result.url, /p_85/);
	assert.equal(result.primeToken, "");
	assert.equal(result.primeEnforced, false);
	assert.equal(
		result.missingPrimeToken,
		false,
		"a disabled filter is not a missing token",
	);
});

test("buildCanonicalSearchUrl preserves a manual prime facet when enforcement is off", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.ca/s?k=goartea&s=review-rank&rh=n%3A6967215011%2Cp_85%3A5690392011",
		{ primeToken: "", enforcePrime: false },
	);

	assert.equal(result.changed, false, "manual facet remains in the url");
	assert.equal(
		result.url,
		"https://www.amazon.ca/s?k=goartea&s=review-rank&rh=n%3A6967215011%2Cp_85%3A5690392011",
	);
	assert.equal(result.primeToken, "p_85:5690392011");
	assert.equal(result.primeEnforced, true);
});

test("buildCanonicalSearchUrl removes prime facets only when explicitly requested", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.com.mx/s?k=ink&s=review-rank&rh=n%3A123%2Cp_n_prime_domestic%3A217698801011%7C217698802011%2Cp_6%3AA2HMM5KJS65BH3",
		{
			primeToken: "p_n_prime_domestic:217698801011|217698802011",
			enforcePrime: false,
			removePrime: true,
		},
	);

	assert.equal(result.changed, true);
	assert.equal(
		result.url,
		"https://www.amazon.com.mx/s?k=ink&s=review-rank&rh=n%3A123%2Cp_6%3AA2HMM5KJS65BH3",
	);
	assert.equal(result.primeToken, "");
	assert.equal(result.primeEnforced, false);
});

test("buildCanonicalSearchUrl deletes rh when explicit removal drops its only facet", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.ca/s?k=goartea&s=review-rank&rh=p_85%3A5690392011",
		{ primeToken: "p_85:5690392011", enforcePrime: false, removePrime: true },
	);

	assert.equal(result.changed, true);
	assert.equal(result.url, "https://www.amazon.ca/s?k=goartea&s=review-rank");
	assert.equal(result.primeToken, "");
	assert.equal(result.primeEnforced, false);
});

test("buildCanonicalSearchUrl removes only the prime facet and preserves seller refinements", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3%2Cp_85%3A5690392011&s=review-rank",
		{ primeToken: "p_85:5690392011", enforcePrime: false, removePrime: true },
	);

	assert.equal(result.changed, true);
	assert.equal(
		result.url,
		"https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank",
	);
});

test("buildCanonicalSearchUrl appends the prime facet to a seller-filtered page", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank",
		{ primeToken: "p_85:5690392011" },
	);

	assert.equal(result.changed, true);
	assert.equal(result.primeEnforced, true);
	assert.match(
		result.url,
		/rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3%2Cp_85%3A5690392011/,
	);
});

test("buildCanonicalSearchUrl recognizes the amazon.com.mx prime key", () => {
	const alreadyFiltered = shared.buildCanonicalSearchUrl(
		"https://www.amazon.com.mx/s?k=ink&s=review-rank&rh=p_n_prime_domestic%3A217698801011",
		{ primeToken: "p_n_prime_domestic:217698801011|217698802011" },
	);

	assert.equal(
		alreadyFiltered.changed,
		false,
		"Amazon's own prime choice is never widened",
	);
	assert.equal(alreadyFiltered.primeToken, "p_n_prime_domestic:217698801011");

	const enforced = shared.buildCanonicalSearchUrl(
		"https://www.amazon.com.mx/s?k=ink",
		{ primeToken: "p_n_prime_domestic:217698801011|217698802011" },
	);

	assert.match(
		enforced.url,
		/rh=p_n_prime_domestic%3A217698801011%7C217698802011/,
	);
});

test("normalizePrimeTokenMap drops hosts and tokens it cannot trust", () => {
	assert.deepEqual(
		shared.normalizePrimeTokenMap({
			"WWW.Amazon.DE": " p_85:20943776031 ",
			"www.amazon.com.mx": "p_n_prime_domestic:217698801011|217698802011",
			"evil.example.com": "p_85:1",
			"www.amazon.fr": "p_72:1234",
			"www.amazon.it": "",
		}),
		{
			"www.amazon.de": "p_85:20943776031",
			"www.amazon.com.mx": "p_n_prime_domestic:217698801011|217698802011",
		},
	);
	assert.deepEqual(shared.normalizePrimeTokenMap(null), {});
});

test("resolvePrimeTokenForHost prefers learned tokens over measured fallbacks", () => {
	assert.equal(
		shared.resolvePrimeTokenForHost("www.amazon.ca", {}),
		"p_85:5690392011",
	);
	assert.equal(
		shared.resolvePrimeTokenForHost("www.amazon.com", {}),
		"p_85:2470955011",
	);
	assert.equal(
		shared.resolvePrimeTokenForHost("www.amazon.com.mx", {}),
		"p_n_prime_domestic:217698801011|217698802011",
	);
	assert.equal(
		shared.resolvePrimeTokenForHost("www.amazon.ca", {
			"www.amazon.ca": "p_85:9999999999",
		}),
		"p_85:9999999999",
	);
	assert.equal(shared.resolvePrimeTokenForHost("www.amazon.de", {}), "");
	assert.equal(shared.resolvePrimeTokenForHost("evil.example.com", {}), "");
	assert.equal(
		shared.resolvePrimeTokenForHost("www.amazon.ca", {
			"www.amazon.ca": "p_72:junk",
		}),
		"p_85:5690392011",
		"an untrusted learned token falls back to the measured token",
	);
});

test("parseBrandWhitelist removes blanks and duplicates", () => {
	assert.deepEqual(shared.parseBrandWhitelist("Apple\n\nSamsung\nApple\n"), [
		"Apple",
		"Samsung",
	]);
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
