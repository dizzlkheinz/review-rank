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

test("buildCanonicalSearchUrl keeps Amazon's own prime facet when enforcement is off", () => {
	const result = shared.buildCanonicalSearchUrl(
		"https://www.amazon.ca/s?k=goartea&s=review-rank&rh=n%3A6967215011%2Cp_85%3A5690392011",
		{ primeToken: "", enforcePrime: false },
	);

	assert.equal(result.changed, false);
	assert.equal(result.primeToken, "p_85:5690392011");
	assert.equal(result.primeEnforced, true);
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
