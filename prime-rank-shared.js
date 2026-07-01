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
			minimumRatings: 100,
			useBrandWhitelist: false,
			hideSponsoredResults: true,
		});

		const DEFAULT_STORAGE_STATE = Object.freeze({
			brandWhitelist: [],
			brandWhitelistFetchedAt: 0,
			brandWhitelistSource: "unavailable",
			brandWhitelistLastAttemptAt: 0,
			brandWhitelistLastError: "",
			brandWhitelistSyncStatus: "idle",
		});

		const BRAND_WHITELIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
		const PRIME_TOKEN_PATTERN = /p_85:[^,&#"'\\\s)]+/g;
		const BRAND_PREFIX_PATTERN = /^(brand|marque|marca|marke|visit the|by)\s+/;
		const BRAND_SUFFIX_PATTERN = /\s+store$/;
		const COUNT_KEYWORD_PATTERN =
			/\b(ratings?|reviews?|bewertung(?:en)?|rezension(?:en)?|evaluations?|avis|calificaciones?|opiniones|recensioni|recensies|avaliac(?:ao|oes)|ratings)\b/i;
		const RATING_NUMBER_PATTERN = /\d+(?:[.,\u202f\u00a0\s]\d+)*/g;
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

		function extractPrimeTokensFromText(text) {
			return uniq(String(text ?? "").match(PRIME_TOKEN_PATTERN) || []);
		}

		function buildCanonicalSearchUrl(currentUrl, options = {}) {
			const url = new URL(String(currentUrl));
			const primeToken = String(options.primeToken ?? "").trim();
			let changed = false;

			if (url.searchParams.get("s") !== "review-rank") {
				url.searchParams.set("s", "review-rank");
				changed = true;
			}

			const rhTokens = splitRhTokens(url.searchParams.get("rh"));
			const existingPrimeToken =
				rhTokens.find((token) => token.startsWith("p_85:")) || "";
			const resolvedPrimeToken = existingPrimeToken || primeToken;

			if (!existingPrimeToken && primeToken) {
				rhTokens.push(primeToken);
				url.searchParams.set("rh", splitRhTokens(rhTokens.join(",")).join(","));
				changed = true;
			}

			return {
				url: url.toString(),
				changed,
				primeToken: resolvedPrimeToken,
				missingPrimeToken: !resolvedPrimeToken,
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
			buildBrandIndex,
			buildCanonicalSearchUrl,
			extractPrimeTokensFromText,
			matchWhitelistedBrand,
			matchesSponsoredLabelText,
			normalizeBrandText,
			normalizeBrandWhitelist,
			normalizeMinimumRatings,
			parseBrandWhitelist,
			parseRatingsCountFromTexts,
			sanitizeSettings,
			shouldRefreshBrandWhitelist,
			splitRhTokens,
			uniq,
		};
	},
);
