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
		const SPONSORED_TEXT_PATTERN =
			/\b(sponsored|gesponsert|sponsorise|sponsorisé|patrocinad[oa]s?|sponsorizzat[oa]s?|gesponsord|sponsorowane|sponsrad|sponsret|sponsad)\b/i;

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
				.replace(/['’]/g, "")
				.replace(/[^a-zA-Z0-9]+/g, " ")
				.trim()
				.toLowerCase();
		}

		function sanitizeBrandCandidate(candidate) {
			return normalizeBrandText(candidate)
				.replace(BRAND_PREFIX_PATTERN, "")
				.replace(BRAND_SUFFIX_PATTERN, "")
				.trim();
		}

		function buildBrandIndex(rawBrands) {
			const groupedBrands = new Map();
			const brands = normalizeBrandWhitelist(rawBrands);

			for (const brand of brands) {
				const normalizedBrand = sanitizeBrandCandidate(brand);

				if (!normalizedBrand) {
					continue;
				}

				const [firstToken] = normalizedBrand.split(" ");

				if (!firstToken) {
					continue;
				}

				const bucket = groupedBrands.get(firstToken) || [];
				bucket.push({
					raw: brand,
					normalized: normalizedBrand,
				});
				groupedBrands.set(firstToken, bucket);
			}

			for (const bucket of groupedBrands.values()) {
				bucket.sort(
					(left, right) => right.normalized.length - left.normalized.length,
				);
			}

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

		function matchWhitelistedBrand(textCandidates, brandIndex) {
			if (!brandIndex || typeof brandIndex.get !== "function") {
				return "";
			}

			for (const text of Array.isArray(textCandidates) ? textCandidates : []) {
				const normalizedText = sanitizeBrandCandidate(text);

				if (!normalizedText) {
					continue;
				}

				const [firstToken] = normalizedText.split(" ");
				const bucket = brandIndex.get(firstToken) || [];

				for (const brand of bucket) {
					if (matchesBrandCandidate(normalizedText, brand)) {
						return brand.raw;
					}
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

		function parseRatingsCountText(text) {
			const rawText = String(text ?? "").trim();

			if (!rawText) {
				return 0;
			}

			const numericTokens =
				rawText.match(/\d+(?:[.,\u202f\u00a0\s]\d+)*/g) || [];
			const parsedNumbers = numericTokens
				.map(parseNumericToken)
				.filter(Boolean);

			if (!parsedNumbers.length) {
				return 0;
			}

			const integerValues = parsedNumbers
				.filter((entry) => entry.type === "integer")
				.map((entry) => entry.value);
			const hasDecimalRating = parsedNumbers.some(
				(entry) => entry.type === "decimal-rating",
			);
			const loweredText = rawText.toLowerCase();

			if (!integerValues.length) {
				return 0;
			}

			if (integerValues.length === 1 && !hasDecimalRating) {
				return integerValues[0];
			}

			if (COUNT_KEYWORD_PATTERN.test(loweredText)) {
				return Math.max(...integerValues);
			}

			const valuesAboveStars = integerValues.filter((value) => value > 5);

			if (valuesAboveStars.length > 0) {
				return Math.max(...valuesAboveStars);
			}

			return 0;
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
			const rawText = String(text ?? "").trim();

			if (!rawText) {
				return false;
			}

			return (
				SPONSORED_TEXT_PATTERN.test(rawText) || rawText.includes("スポンサー")
			);
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
