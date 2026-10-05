(function attachPrimeRankShared(root, factory) {
	const sharedApi = factory();

	root.PrimeRankShared = sharedApi;

	if (typeof module === "object" && module.exports) {
		module.exports = sharedApi;
	}
})(
	typeof globalThis !== "undefined" ? globalThis : this,
	function createPrimeRankShared() {
		const DEFAULT_SETTINGS = Object.freeze({
			enabled: true,
			enforcePrime: true,
			minimumRatings: 100,
			useBrandWhitelist: false,
			hideSponsoredResults: true,
		});

		const DEFAULT_STORAGE_STATE = Object.freeze({
			brandWhitelist: [],
			primeTokensByHost: {},
			brandWhitelistFetchedAt: 0,
			brandWhitelistSource: "unavailable",
			brandWhitelistLastAttemptAt: 0,
			brandWhitelistLastError: "",
			brandWhitelistSyncStatus: "idle",
		});

		const BRAND_WHITELIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
		// Amazon does not use one Prime refinement key everywhere: amazon.ca and
		// amazon.com expose p_85, while amazon.com.mx splits Prime into two values
		// of p_n_prime_domestic. Several values of one key are OR-joined with "|".
		const PRIME_TOKEN_KEYS = Object.freeze(["p_85", "p_n_prime_domestic"]);
		const PRIME_TOKEN_PATTERN = /(?:p_85|p_n_prime_domestic):[^,&#"'\\\s)]+/g;
		const PRIME_TOKEN_VALUE_PATTERN =
			/^(?:p_85|p_n_prime_domestic):[0-9A-Za-z]+(?:\|[0-9A-Za-z]+)*$/;
		const PRIME_TOKEN_HOST_PATTERN =
			/^(?:[a-z0-9-]+\.)*amazon\.[a-z]{2,3}(?:\.[a-z]{2,3})?$/;
		// Every entry was measured against the live marketplace on 2026-08-15:
		//   amazon.ca    /s?k=goartea&i=grocery&rh=n:6967215011,p_6:A2HMM5KJS65BH3
		//                86 results -> 3, category and seller refinements intact.
		//   amazon.com   /s?k=poly+bags&rh=n:8553197011
		//                4,000+ results -> 1, category refinement intact.
		//   amazon.com.mx /s?k=ink
		//                422 results -> 275. Both p_n_prime_domestic values are
		//                Prime (domestic and global), so enforcement keeps the
		//                union instead of guessing which half the user wants.
		// Tokens are marketplace-specific and a foreign or invalid token is
		// destructive: Amazon then discards every sibling refinement (amazon.ca's
		// token on amazon.com widened 4,000 -> 10,000 results, exactly like the
		// bogus token p_85:999999999). Only measured hosts may be listed here;
		// other marketplaces learn their token from Amazon's own Prime refinement
		// link at runtime.
		const PRIME_TOKEN_FALLBACKS = Object.freeze({
			"www.amazon.ca": "p_85:5690392011",
			"www.amazon.com": "p_85:2470955011",
			"www.amazon.com.mx": "p_n_prime_domestic:217698801011|217698802011",
		});
		const BRAND_PREFIX_PATTERN = /^(brand|marque|marca|marke|visit the|by)\s+/;
		const BRAND_SUFFIX_PATTERN = /\s+store$/;
		const COUNT_KEYWORD_PATTERN =
			/\b(ratings?|reviews?|bewertung(?:en)?|rezension(?:en)?|evaluations?|avis|calificaciones?|opiniones|recensioni|recensies|avaliac(?:ao|oes)|ratings)\b/i;
		const RATING_NUMBER_PATTERN = /\d+(?:[.,\u202f\u00a0\s]\d+)*/g;
		const ABBREVIATED_COUNT_PATTERN =
			/(\d+(?:[.,]\d+)?)\s*(k|m|tsd\.?|mil)(?![\p{L}])/giu;
		const SPONSORED_TEXT_PATTERN =
			/\b(sponsored|gesponsert|sponsorise|sponsorisé|patrocinad[oa]s?|sponsorizzat[oa]s?|gesponsord|sponsorowane|sponsrad|sponsret|sponsad|sponsorlu)\b/i;

		function normalizeMinimumRatings(value) {
			const numericValue = Number.parseInt(String(value ?? ""), 10);

			if (!Number.isFinite(numericValue) || numericValue < 0) {
				return DEFAULT_SETTINGS.minimumRatings;
			}

			return Math.min(numericValue, 1_000_000);
		}

		function sanitizeSettings(rawSettings = {}) {
			return {
				enabled: rawSettings.enabled !== false,
				enforcePrime: rawSettings.enforcePrime !== false,
				minimumRatings: normalizeMinimumRatings(rawSettings.minimumRatings),
				useBrandWhitelist: rawSettings.useBrandWhitelist === true,
				hideSponsoredResults: rawSettings.hideSponsoredResults !== false,
			};
		}

		function normalizeBrandWhitelist(rawWhitelist) {
			if (!Array.isArray(rawWhitelist)) {
				return [];
			}

			const seen = new Set();
			const normalizedList = [];

			for (const brand of rawWhitelist) {
				const text = String(brand ?? "").trim();

				if (!text || seen.has(text)) {
					continue;
				}

				seen.add(text);
				normalizedList.push(text);
			}

			return normalizedList;
		}

		function parseBrandWhitelist(text) {
			return normalizeBrandWhitelist(String(text ?? "").split(/\r?\n/));
		}

		function shouldRefreshBrandWhitelist(options = {}) {
			const now = Number(options.now ?? Date.now());
			const maxAgeMs = Number(options.maxAgeMs ?? BRAND_WHITELIST_MAX_AGE_MS);
			const currentWhitelist = normalizeBrandWhitelist(options.brandWhitelist);
			const fetchedAt = Number(options.brandWhitelistFetchedAt || 0);

			if (!currentWhitelist.length) {
				return true;
			}

			return now - fetchedAt >= maxAgeMs;
		}

		function normalizeBrandText(value) {
			return String(value ?? "")
				.normalize("NFKD")
				.replace(/[\u0300-\u036f]/g, "")
				.replace(/&/g, " and ")
				.replace(/['‘’ʼ]/g, "")
				.replace(/[^\p{L}\p{N}]+/gu, " ")
				.trim()
				.toLowerCase();
		}

		function sanitizeBrandCandidate(candidate) {
			return normalizeBrandText(candidate)
				.replace(BRAND_PREFIX_PATTERN, "")
				.replace(BRAND_SUFFIX_PATTERN, "")
				.trim();
		}

		function createBrandIndexEntry(brand) {
			const normalizedBrand = sanitizeBrandCandidate(brand);

			if (!normalizedBrand) {
				return null;
			}

			const [firstToken] = normalizedBrand.split(" ");

			if (!firstToken) {
				return null;
			}

			return {
				firstToken,
				brand: {
					raw: brand,
					normalized: normalizedBrand,
				},
			};
		}

		function addBrandToIndex(groupedBrands, brand) {
			const entry = createBrandIndexEntry(brand);

			if (!entry) {
				return;
			}

			const bucket = groupedBrands.get(entry.firstToken) || [];
			bucket.push(entry.brand);
			groupedBrands.set(entry.firstToken, bucket);
		}

		function sortBrandIndex(groupedBrands) {
			for (const bucket of groupedBrands.values()) {
				bucket.sort(
					(left, right) => right.normalized.length - left.normalized.length,
				);
			}
		}

		function buildBrandIndex(rawBrands) {
			const groupedBrands = new Map();
			const brands = normalizeBrandWhitelist(rawBrands);

			for (const brand of brands) {
				addBrandToIndex(groupedBrands, brand);
			}

			sortBrandIndex(groupedBrands);

			return groupedBrands;
		}

		function matchesBrandCandidate(candidate, brand) {
			return (
				candidate === brand.normalized ||
				candidate.startsWith(`${brand.normalized} `) ||
				candidate.startsWith(`${brand.normalized}-`) ||
				candidate.startsWith(`${brand.normalized}:`)
			);
		}

		function getBrandBucket(normalizedText, brandIndex) {
			const [firstToken] = normalizedText.split(" ");
			return firstToken ? brandIndex.get(firstToken) || [] : [];
		}

		function findMatchingBrand(normalizedText, brands) {
			for (const brand of brands) {
				if (matchesBrandCandidate(normalizedText, brand)) {
					return brand.raw;
				}
			}

			return "";
		}

		function matchWhitelistedBrand(textCandidates, brandIndex) {
			if (!brandIndex || typeof brandIndex.get !== "function") {
				return "";
			}

			for (const text of Array.isArray(textCandidates) ? textCandidates : []) {
				const normalizedText = sanitizeBrandCandidate(text);

				if (!normalizedText) {
					continue;
				}

				const matchedBrand = findMatchingBrand(
					normalizedText,
					getBrandBucket(normalizedText, brandIndex),
				);

				if (matchedBrand) {
					return matchedBrand;
				}
			}

			return "";
		}

		function parseNumericToken(rawToken) {
			const token = String(rawToken ?? "").trim();

			if (!token) {
				return null;
			}

			const normalized = token.replace(/[\u202f\u00a0\s]/g, "");

			if (/^\d+[.,]\d{1,2}$/.test(normalized)) {
				const decimalValue = Number(normalized.replace(",", "."));

				if (Number.isFinite(decimalValue) && decimalValue <= 5) {
					return {
						type: "decimal-rating",
						value: decimalValue,
					};
				}
			}

			const digitsOnly = normalized.replace(/[^\d]/g, "");

			if (!digitsOnly) {
				return null;
			}

			return {
				type: "integer",
				value: Number.parseInt(digitsOnly, 10),
			};
		}

		function parseRatingNumbers(text) {
			return (text.match(RATING_NUMBER_PATTERN) || [])
				.map(parseNumericToken)
				.filter(Boolean);
		}

		function getIntegerRatingValues(parsedNumbers) {
			return parsedNumbers
				.filter((entry) => entry.type === "integer")
				.map((entry) => entry.value);
		}

		function hasDecimalRating(parsedNumbers) {
			return parsedNumbers.some((entry) => entry.type === "decimal-rating");
		}

		function selectRatingsCount(rawText, integerValues, parsedNumbers) {
			if (integerValues.length === 1 && !hasDecimalRating(parsedNumbers)) {
				return integerValues[0];
			}

			if (COUNT_KEYWORD_PATTERN.test(rawText.toLowerCase())) {
				return Math.max(...integerValues);
			}

			const valuesAboveStars = integerValues.filter((value) => value > 5);
			return valuesAboveStars.length > 0 ? Math.max(...valuesAboveStars) : 0;
		}

		function parseRatingsCountText(text) {
			const rawText = String(text ?? "").trim();

			if (!rawText) {
				return 0;
			}

			const abbreviatedCounts = [
				...rawText.matchAll(ABBREVIATED_COUNT_PATTERN),
			].map((match) => {
				const suffix = match[2].toLowerCase();
				const multiplier = suffix === "m" ? 1_000_000 : 1_000;
				const numericValue = Number(match[1].replace(",", "."));
				return Number.isFinite(numericValue)
					? Math.round(numericValue * multiplier)
					: 0;
			});

			if (abbreviatedCounts.length) {
				return Math.max(...abbreviatedCounts);
			}

			const parsedNumbers = parseRatingNumbers(rawText);

			if (!parsedNumbers.length) {
				return 0;
			}

			const integerValues = getIntegerRatingValues(parsedNumbers);

			if (!integerValues.length) {
				return 0;
			}

			return selectRatingsCount(rawText, integerValues, parsedNumbers);
		}

		function parseRatingsCountFromTexts(textCandidates) {
			for (const text of Array.isArray(textCandidates) ? textCandidates : []) {
				const ratingsCount = parseRatingsCountText(text);

				if (ratingsCount > 0) {
					return ratingsCount;
				}
			}

			return 0;
		}

		function uniq(values) {
			const seen = new Set();
			const result = [];

			for (const value of Array.isArray(values) ? values : []) {
				if (!value || seen.has(value)) {
					continue;
				}

				seen.add(value);
				result.push(value);
			}

			return result;
		}

		function splitRhTokens(value) {
			return uniq(
				String(value ?? "")
					.split(",")
					.map((token) => token.trim())
					.filter(Boolean),
			);
		}

		// Amazon writes refinements percent-encoded inside hrefs
		// (rh=n%3A123%2Cp_85%3A456), plain inside inline scripts, and sometimes
		// double-encoded after its own server-side redirect (amazon.com.mx rewrites
		// the multi-value separator %7C to %257C), so every form has to survive
		// extraction.
		function decodeRefinementText(text) {
			return String(text ?? "")
				.replace(/%(?:25)?3A/gi, ":")
				.replace(/%(?:25)?7C/gi, "|")
				.replace(/%(?:25)?2C/gi, ",");
		}

		function extractPrimeTokensFromText(text) {
			return uniq(
				decodeRefinementText(text).match(PRIME_TOKEN_PATTERN) || [],
			).filter(isPrimeTokenValue);
		}

		function isPrimeTokenValue(value) {
			return PRIME_TOKEN_VALUE_PATTERN.test(String(value ?? "").trim());
		}

		function isPrimeRefinementToken(token) {
			return PRIME_TOKEN_KEYS.some((key) =>
				String(token ?? "").startsWith(`${key}:`),
			);
		}

		function normalizePrimeTokenHost(value) {
			const host = String(value ?? "")
				.trim()
				.toLowerCase();

			return PRIME_TOKEN_HOST_PATTERN.test(host) ? host : "";
		}

		function normalizePrimeTokenMap(rawMap) {
			const normalizedMap = {};

			if (!rawMap || typeof rawMap !== "object") {
				return normalizedMap;
			}

			for (const [rawHost, rawToken] of Object.entries(rawMap)) {
				const host = normalizePrimeTokenHost(rawHost);
				const token = String(rawToken ?? "").trim();

				if (host && isPrimeTokenValue(token)) {
					normalizedMap[host] = token;
				}
			}

			return normalizedMap;
		}

		function resolvePrimeTokenForHost(hostname, learnedTokens) {
			const host = normalizePrimeTokenHost(hostname);

			if (!host) {
				return "";
			}

			const learnedToken = String(learnedTokens?.[host] ?? "").trim();

			if (isPrimeTokenValue(learnedToken)) {
				return learnedToken;
			}

			return PRIME_TOKEN_FALLBACKS[host] || "";
		}

		function buildCanonicalSearchUrl(currentUrl, options = {}) {
			const url = new URL(String(currentUrl));
			const enforcePrime = options.enforcePrime !== false;
			const primeToken = String(options.primeToken ?? "").trim();
			let changed = false;

			if (url.searchParams.get("s") !== "review-rank") {
				url.searchParams.set("s", "review-rank");
				changed = true;
			}

			const rhTokens = splitRhTokens(url.searchParams.get("rh"));
			const existingPrimeToken = rhTokens.find(isPrimeRefinementToken) || "";

			let resolvedPrimeToken = "";
			if (enforcePrime) {
				resolvedPrimeToken = existingPrimeToken || primeToken;
				if (!existingPrimeToken && primeToken) {
					rhTokens.push(primeToken);
					url.searchParams.set(
						"rh",
						splitRhTokens(rhTokens.join(",")).join(","),
					);
					changed = true;
				}
			} else if (options.removePrime === true && existingPrimeToken) {
				const remainingTokens = rhTokens.filter(
					(token) => !isPrimeRefinementToken(token),
				);
				if (remainingTokens.length > 0) {
					url.searchParams.set("rh", remainingTokens.join(","));
				} else {
					url.searchParams.delete("rh");
				}
				changed = true;
			} else {
				resolvedPrimeToken = existingPrimeToken;
			}

			return {
				url: url.toString(),
				changed,
				primeToken: resolvedPrimeToken,
				primeEnforced: Boolean(resolvedPrimeToken),
				missingPrimeToken: enforcePrime && !resolvedPrimeToken,
			};
		}

		function matchesSponsoredLabelText(text) {
			let rawText = String(text ?? "").trim();

			if (!rawText) {
				return false;
			}

			// Remove zero-width spaces, soft hyphens, and other control/non-printing chars
			rawText = rawText.replace(/[\u200b-\u200d\ufeff\u00ad]/g, "");

			if (
				SPONSORED_TEXT_PATTERN.test(rawText) ||
				rawText.includes("スポンサー") ||
				rawText.includes("赞助") ||
				rawText.includes("广告") ||
				rawText.includes("스폰서") ||
				rawText.includes("ممول") ||
				rawText.includes("إعلان")
			) {
				return true;
			}

			// Clean for fuzzy spacing/obfuscation (e.g. "S p o n s o r e d")
			const cleaned = rawText
				.toLowerCase()
				.normalize("NFKD")
				.replace(/[\u0300-\u036f]/g, "")
				.replace(
					/[^a-z0-9\u00c0-\u00ff\u0100-\u017f\u0400-\u04ff\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/gu,
					"",
				);

			const sponsoredFuzzyKeywords = [
				"sponsored",
				"gesponsert",
				"sponsorise",
				"patrocinado",
				"patrocinada",
				"sponsorizzato",
				"sponsorizzata",
				"gesponsord",
				"sponsorowane",
				"sponsrad",
				"sponsret",
				"sponsad",
				"sponsorlu",
			];

			for (const kw of sponsoredFuzzyKeywords) {
				if (cleaned.includes(kw)) {
					return true;
				}
			}

			return false;
		}

		return {
			BRAND_WHITELIST_MAX_AGE_MS,
			DEFAULT_SETTINGS,
			DEFAULT_STORAGE_STATE,
			PRIME_TOKEN_FALLBACKS,
			PRIME_TOKEN_KEYS,
			buildBrandIndex,
			buildCanonicalSearchUrl,
			extractPrimeTokensFromText,
			matchWhitelistedBrand,
			matchesSponsoredLabelText,
			normalizeBrandText,
			normalizeBrandWhitelist,
			normalizeMinimumRatings,
			normalizePrimeTokenMap,
			parseBrandWhitelist,
			parseRatingsCountFromTexts,
			resolvePrimeTokenForHost,
			sanitizeSettings,
			shouldRefreshBrandWhitelist,
			splitRhTokens,
			uniq,
		};
	},
);
