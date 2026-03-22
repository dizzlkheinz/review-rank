const extensionApi = globalThis.browser ?? globalThis.chrome;
const {
	DEFAULT_SETTINGS,
	DEFAULT_STORAGE_STATE,
	buildBrandIndex,
	buildCanonicalSearchUrl,
	extractPrimeTokensFromText,
	matchWhitelistedBrand,
	matchesSponsoredLabelText,
	normalizeBrandWhitelist,
	parseRatingsCountFromTexts,
	sanitizeSettings,
} = globalThis.PrimeRankShared;

const RESULTS_CONTAINER_SELECTORS = [
	"div.s-main-slot.s-result-list",
	"div.s-search-results",
	"div.s-main-slot",
];
const RESULTS_CONTAINER_SELECTOR = RESULTS_CONTAINER_SELECTORS.join(", ");
const RESULT_CARD_SELECTOR = [
	"div[data-component-type='s-search-result'][data-asin]",
	"div[data-component-type='s-impression-counter']",
	"div.s-widget-container[data-csa-c-type='item'][data-csa-c-item-id*='.asin']",
].join(", ");
const RESULT_CARD_INNER_SELECTOR = [
	"[data-cy='asin-faceout-container']",
	".puis-card-container.s-card-container",
].join(", ");
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
	"a[href*='/stores/'] span",
	"[data-cy='byline-recipe'] .a-size-base",
	"[data-cy='brand'] span",
	".a-size-base.a-color-secondary",
];
const PRIME_TOKEN_ATTRIBUTE_SELECTOR = [
	"a[href*='p_85']",
	"[data-url*='p_85']",
	"[data-query*='p_85']",
	"[data-a-modal*='p_85']",
	"input[value*='p_85']",
].join(", ");
const SPONSORED_LABEL_SELECTORS = [
	".puis-sponsored-label-text",
	".s-sponsored-label-text",
	".puis-label-popover",
	".s-label-popover",
	".s-label-popover-hover",
];
const SPONSORED_DATA_SELECTORS = ["[data-ad-feedback]", "[data-ad-details]"];
const SPONSORED_STRUCTURAL_SELECTOR = [
	"[data-component-type='sp-sponsored-result']",
	"[data-cel-widget^='sp_']",
	"[data-cel-widget*='sp-sponsored']",
	...SPONSORED_DATA_SELECTORS,
	"[data-ad-id]",
	"[id^='sp_']",
	...SPONSORED_LABEL_SELECTORS,
].join(", ");
const SPONSORED_TEXT_SELECTORS = [
	...SPONSORED_LABEL_SELECTORS,
	...SPONSORED_DATA_SELECTORS,
].join(", ");
const SPONSORED_SIGNAL_SELECTOR = [
	"[data-ad-feedback-label-id]",
	"[data-ad-feedback-payload]",
	"[data-is-sponsored-label-active='true']",
	"[data-ad-feedback-payload*='\"slotName\"']",
].join(", ");
const SPONSORED_LINK_SELECTOR = [
	"a[href*='/x/c/']",
	"a[href*='hsa_cr_id=']",
	"a[href*='ref_=sbx_']",
	"a[href*='/sspa/click']",
].join(", ");
const SPONSORED_MEDIA_SELECTOR = [
	"img[alt^='Sponsored Ad']",
	"[aria-label^='Sponsored Ad']",
	"[aria-label*='Sponsored ad']",
].join(", ");
const SPONSORED_ANY_SELECTOR = [
	SPONSORED_SIGNAL_SELECTOR,
	SPONSORED_LINK_SELECTOR,
	SPONSORED_TEXT_SELECTORS,
	SPONSORED_MEDIA_SELECTOR,
].join(", ");
const SPONSORED_HIDE_TARGET_SELECTOR = [
	"[cel_widget_id]",
	".sg-col-inner",
	"div.s-widget-container",
	"div[data-component-type='s-impression-logger']",
	"div[data-component-type='s-impression-counter']",
	"div.s-featured-result-item",
	"li.a-carousel-card",
	"[data-sbtc-carousel-item='true']",
	"[data-asin][data-avar]",
	"div[data-asin]",
].join(", ");
const NAVIGATION_CHECK_INTERVAL_MS = 1500;
const SPONSORED_LINK_PATTERNS = [
	/\/\/aax-[^/]*amazon\.[^/]+\/x\/c\//i,
	/\/sspa\/click/i,
	/[?&]hsa_cr_id=/i,
	/[?&]ref_=sbx_/i,
];

const cache = { sponsored: new WeakMap() };

const STATE = {
	settings: { ...DEFAULT_SETTINGS },
	brandWhitelist: normalizeBrandWhitelist(DEFAULT_STORAGE_STATE.brandWhitelist),
	brandIndex: null,
	applyTimerId: 0,
	isApplying: false,
	rerunRequested: false,
	rerunFullRefresh: false,
	observedContainer: null,
	resultsObserver: null,
	locationHref: window.location.href,
	navigationPollId: 0,
	primeTokenHref: "",
	primeTokenValue: "",
	pageStatus: createDefaultPageStatus(),
};

function createDefaultPageStatus() {
	return {
		enabled: true,
		supportedPage: false,
		totalCount: 0,
		visibleCount: 0,
		hiddenCount: 0,
		hiddenByRatings: 0,
		hiddenByBrand: 0,
		hiddenBySponsored: 0,
		hiddenSponsoredModules: 0,
		minimumRatings: DEFAULT_SETTINGS.minimumRatings,
		useBrandWhitelist: DEFAULT_SETTINGS.useBrandWhitelist,
		hideSponsoredResults: DEFAULT_SETTINGS.hideSponsoredResults,
		whitelistAvailable: false,
		whitelistCount: 0,
		primeStatus: "idle",
		sortStatus: "idle",
		lastUpdatedAt: 0,
	};
}

function updatePageStatus(partialStatus) {
	STATE.pageStatus = {
		...STATE.pageStatus,
		...partialStatus,
		lastUpdatedAt: Date.now(),
	};
}

function getTextCandidates(root, selectors) {
	const seen = new Set();
	const values = [];
	const normalizedSelectors = Array.isArray(selectors)
		? selectors
		: [selectors];

	for (const selector of normalizedSelectors) {
		if (!selector) {
			continue;
		}

		const nodes = root.querySelectorAll(selector);

		for (const node of nodes) {
			const text = (
				node.getAttribute("aria-label") ||
				node.getAttribute("data-ad-feedback") ||
				node.textContent ||
				""
			).trim();

			if (!text || seen.has(text)) {
				continue;
			}

			seen.add(text);
			values.push(text);
		}
	}

	return values;
}

function matchesSelectorOrDescendant(root, selector) {
	if (!(root instanceof Element)) {
		return false;
	}

	return root.matches(selector) || Boolean(root.querySelector(selector));
}

function findResultsContainer() {
	for (const selector of RESULTS_CONTAINER_SELECTORS) {
		const container = document.querySelector(selector);

		if (container) {
			return container;
		}
	}

	return null;
}

function getSearchResultCards(root) {
	if (!root) {
		return [];
	}

	const cards = new Set();
	const addCard = (node) => {
		const card = resolveResultCardRoot(node);

		if (card) {
			cards.add(card);
		}
	};

	addCard(root);

	for (const card of root.querySelectorAll(RESULT_CARD_SELECTOR)) {
		addCard(card);
	}

	for (const innerCard of root.querySelectorAll(RESULT_CARD_INNER_SELECTOR)) {
		addCard(innerCard);
	}

	return Array.from(cards);
}

function resolveResultCardRoot(node) {
	if (!(node instanceof Element)) {
		return null;
	}

	return (
		node.closest(
			"div.s-widget-container[data-csa-c-type='item'][data-csa-c-item-id*='.asin']",
		) ||
		node.closest("div[data-component-type='s-search-result'][data-asin]") ||
		node.closest("div[data-component-type='s-impression-counter']") ||
		null
	);
}

function getUniqueCards(cards) {
	return Array.from(new Set(cards.filter(Boolean)));
}

function isFilterableResultsPage(container = findResultsContainer()) {
	return Boolean(container && getSearchResultCards(container).length > 0);
}

function disconnectResultsObserver() {
	if (!STATE.resultsObserver) {
		return;
	}

	STATE.resultsObserver.disconnect();
	STATE.resultsObserver = null;
	STATE.observedContainer = null;
}

function resetPrimeTokenCache() {
	STATE.primeTokenHref = "";
	STATE.primeTokenValue = "";
}

function addScoredPrimeTokens(scoresByToken, text, score) {
	for (const token of extractPrimeTokensFromText(text)) {
		scoresByToken.set(token, (scoresByToken.get(token) || 0) + score);
	}
}

function resolvePrimeToken() {
	if (STATE.primeTokenHref === window.location.href && STATE.primeTokenValue) {
		return STATE.primeTokenValue;
	}

	const scoresByToken = new Map();

	addScoredPrimeTokens(scoresByToken, window.location.href, 100);

	for (const element of document.querySelectorAll(
		PRIME_TOKEN_ATTRIBUTE_SELECTOR,
	)) {
		for (const attributeName of [
			"href",
			"data-url",
			"data-query",
			"data-a-modal",
			"value",
		]) {
			const attributeValue = element.getAttribute(attributeName);

			if (attributeValue) {
				addScoredPrimeTokens(scoresByToken, attributeValue, 60);
			}
		}
	}

	let scannedCharacters = 0;

	for (const script of document.querySelectorAll("script:not([src])")) {
		const scriptText = script.textContent || "";

		if (!scriptText) {
			continue;
		}

		scannedCharacters += scriptText.length;
		addScoredPrimeTokens(scoresByToken, scriptText, 12);

		if (scannedCharacters >= 350000) {
			break;
		}
	}

	let resolvedPrimeToken = "";
	let resolvedScore = -1;

	for (const [token, score] of scoresByToken.entries()) {
		if (score > resolvedScore) {
			resolvedPrimeToken = token;
			resolvedScore = score;
		}
	}

	STATE.primeTokenHref = window.location.href;
	STATE.primeTokenValue = resolvedPrimeToken;

	return resolvedPrimeToken;
}

function ensureCanonicalSearchUrl() {
	if (!isFilterableResultsPage()) {
		updatePageStatus({
			supportedPage: false,
			primeStatus: "not-search-page",
			sortStatus: "not-search-page",
			totalCount: 0,
			visibleCount: 0,
			hiddenCount: 0,
			hiddenByRatings: 0,
			hiddenByBrand: 0,
			hiddenBySponsored: 0,
		});
		return false;
	}

	const canonicalUrl = buildCanonicalSearchUrl(window.location.href, {
		primeToken: resolvePrimeToken(),
	});

	updatePageStatus({
		supportedPage: true,
		primeStatus: canonicalUrl.missingPrimeToken ? "missing-token" : "enforced",
		sortStatus: "review-rank",
	});

	if (!canonicalUrl.changed) {
		return false;
	}

	window.location.replace(canonicalUrl.url);
	return true;
}

function ensureBrandIndex() {
	if (!STATE.settings.useBrandWhitelist) {
		return null;
	}

	if (STATE.brandIndex) {
		return STATE.brandIndex;
	}

	if (!STATE.brandWhitelist.length) {
		return null;
	}

	STATE.brandIndex = buildBrandIndex(STATE.brandWhitelist);
	return STATE.brandIndex;
}

function parseRatingsCount(card) {
	return parseRatingsCountFromTexts(
		getTextCandidates(card, RATING_TEXT_SELECTORS),
	);
}

function findWhitelistedBrand(card) {
	const brandIndex = ensureBrandIndex();

	if (!brandIndex) {
		return "";
	}

	return matchWhitelistedBrand(
		getTextCandidates(card, BRAND_TEXT_SELECTORS),
		brandIndex,
	);
}

function getSponsoredDetectionScopes(card) {
	const scopes = [card];
	let currentNode = card.parentElement;

	while (currentNode && scopes.length < 5) {
		if (getSearchResultCards(currentNode).length > 1) {
			break;
		}

		scopes.push(currentNode);
		currentNode = currentNode.parentElement;
	}

	return scopes;
}

function scopeContainsSponsoredLink(scope) {
	const links = scope.matches?.("a[href]")
		? [scope, ...scope.querySelectorAll("a[href]")]
		: scope.querySelectorAll?.("a[href]") || [];

	for (const link of links) {
		const href = link.getAttribute("href") || "";

		if (!href) {
			continue;
		}

		if (SPONSORED_LINK_PATTERNS.some((pattern) => pattern.test(href))) {
			return true;
		}
	}

	return false;
}

function isSponsoredCard(card) {
	const cached = cache.sponsored.get(card);

	if (cached !== undefined) {
		return cached;
	}

	const result = isSponsoredCardUncached(card);
	cache.sponsored.set(card, result);
	return result;
}

function isSponsoredCardUncached(card) {
	for (const scope of getSponsoredDetectionScopes(card)) {
		if (
			scope.matches?.(SPONSORED_STRUCTURAL_SELECTOR) ||
			scope.querySelector?.(SPONSORED_STRUCTURAL_SELECTOR)
		) {
			return true;
		}

		for (const text of [
			scope.getAttribute?.("data-ad-feedback"),
			scope.getAttribute?.("data-ad-details"),
			scope.getAttribute?.("data-component-type"),
			scope.getAttribute?.("data-cel-widget"),
			scope.getAttribute?.("id"),
			scope.getAttribute?.("aria-label"),
		]) {
			if (matchesSponsoredLabelText(text)) {
				return true;
			}
		}

		if (
			getTextCandidates(scope, SPONSORED_TEXT_SELECTORS).some(
				matchesSponsoredLabelText,
			)
		) {
			return true;
		}

		if (scopeContainsSponsoredLink(scope)) {
			return true;
		}

		if (matchesSponsoredLabelText((scope.textContent || "").slice(0, 1600))) {
			return true;
		}
	}

	return false;
}

function evaluateCard(card) {
	const ratingsCount = parseRatingsCount(card);
	const sponsored = STATE.settings.hideSponsoredResults
		? isSponsoredCard(card)
		: false;
	const matchedBrand = STATE.settings.useBrandWhitelist
		? findWhitelistedBrand(card)
		: "";
	const hiddenReasons = [];

	if (STATE.settings.hideSponsoredResults && sponsored) {
		hiddenReasons.push("sponsored");
	}

	if (ratingsCount < STATE.settings.minimumRatings) {
		hiddenReasons.push("low-reviews");
	}

	if (STATE.settings.useBrandWhitelist && !matchedBrand) {
		hiddenReasons.push("brand");
	}

	return {
		keep: hiddenReasons.length === 0,
		hiddenReasons,
		matchedBrand,
		ratingsCount,
		sponsored,
	};
}

function applyEvaluation(card, evaluation) {
	if (evaluation.keep) {
		card.style.removeProperty("display");
	} else {
		card.style.setProperty("display", "none", "important");
	}

	card.dataset.primeRankFilter = evaluation.keep ? "visible" : "hidden";
	card.dataset.primeRankHiddenReasons = evaluation.hiddenReasons.join(",");
	card.dataset.primeRankReviewCount = String(evaluation.ratingsCount);
	card.dataset.primeRankBrand = evaluation.matchedBrand;
	card.dataset.primeRankWhitelist = STATE.settings.useBrandWhitelist
		? evaluation.matchedBrand
			? "allowed"
			: "blocked"
		: "off";
	card.dataset.primeRankSponsored = evaluation.sponsored
		? "sponsored"
		: "organic";
}

function applyProductFiltersToCards(cards) {
	for (const card of getUniqueCards(cards)) {
		applyEvaluation(card, evaluateCard(card));
	}
}

function clearCardState(card) {
	card.style.removeProperty("display");
	delete card.dataset.primeRankFilter;
	delete card.dataset.primeRankHiddenReasons;
	delete card.dataset.primeRankReviewCount;
	delete card.dataset.primeRankBrand;
	delete card.dataset.primeRankWhitelist;
	delete card.dataset.primeRankSponsored;
}

function clearSponsoredModuleState() {
	for (const node of document.querySelectorAll(
		"[data-prime-rank-sponsored-module='hidden']",
	)) {
		node.style.removeProperty("display");
		delete node.dataset.primeRankSponsoredModule;
	}
}

function resolveSponsoredHideTarget(signalNode) {
	if (!(signalNode instanceof Element)) {
		return null;
	}

	return signalNode.closest(SPONSORED_HIDE_TARGET_SELECTOR);
}

function getStandaloneSponsoredBlocks(root = document.body) {
	if (!(root instanceof Element) || !STATE.settings.hideSponsoredResults) {
		return [];
	}

	const blocks = new Set();
	const signalNodes = root.querySelectorAll(SPONSORED_ANY_SELECTOR);

	for (const signalNode of signalNodes) {
		const block = resolveSponsoredHideTarget(signalNode);

		if (block) {
			blocks.add(block);
		}
	}

	return Array.from(blocks);
}

function applyStandaloneSponsoredBlocks(root = document.body) {
	for (const block of getStandaloneSponsoredBlocks(root)) {
		block.style.setProperty("display", "none", "important");
		block.dataset.primeRankSponsoredModule = "hidden";
	}
}

function resetProductFilters() {
	for (const card of getSearchResultCards(
		findResultsContainer() || document.body,
	)) {
		clearCardState(card);
	}

	clearSponsoredModuleState();

	const container = findResultsContainer();
	const whitelistCount = STATE.brandWhitelist.length;

	updatePageStatus({
		enabled: false,
		supportedPage: isFilterableResultsPage(container),
		minimumRatings: STATE.settings.minimumRatings,
		useBrandWhitelist: STATE.settings.useBrandWhitelist,
		hideSponsoredResults: STATE.settings.hideSponsoredResults,
		whitelistAvailable: whitelistCount > 0,
		whitelistCount,
		primeStatus: "disabled",
		sortStatus: "disabled",
		...summarizeResults(container),
	});

	notifyBadgeCount();
}

function summarizeResults(container = findResultsContainer()) {
	const cards = getSearchResultCards(container);
	const summary = {
		totalCount: cards.length,
		visibleCount: 0,
		hiddenCount: 0,
		hiddenByRatings: 0,
		hiddenByBrand: 0,
		hiddenBySponsored: 0,
		hiddenSponsoredModules: document.querySelectorAll(
			"[data-prime-rank-sponsored-module='hidden']",
		).length,
	};

	for (const card of cards) {
		const hiddenByModule = Boolean(
			card.closest("[data-prime-rank-sponsored-module='hidden']"),
		);
		const isVisible =
			card.dataset.primeRankFilter !== "hidden" && hiddenByModule === false;
		const hiddenReasons = (card.dataset.primeRankHiddenReasons || "")
			.split(",")
			.filter(Boolean);

		if (isVisible) {
			summary.visibleCount += 1;
			continue;
		}

		summary.hiddenCount += 1;

		if (hiddenReasons.includes("low-reviews")) {
			summary.hiddenByRatings += 1;
		}

		if (hiddenReasons.includes("brand")) {
			summary.hiddenByBrand += 1;
		}

		if (hiddenByModule || hiddenReasons.includes("sponsored")) {
			summary.hiddenBySponsored += 1;
		}
	}

	return summary;
}

function notifyBadgeCount() {
	extensionApi.runtime
		.sendMessage({
			type: "prime-rank-filter:update-badge",
			hiddenCount:
				STATE.pageStatus.hiddenCount + STATE.pageStatus.hiddenSponsoredModules,
			enabled: STATE.settings.enabled,
			supportedPage: STATE.pageStatus.supportedPage,
		})
		.catch(() => {});
}

function refreshPageSummary(container = findResultsContainer()) {
	const whitelistCount = STATE.brandWhitelist.length;

	updatePageStatus({
		enabled: STATE.settings.enabled,
		supportedPage: isFilterableResultsPage(container),
		minimumRatings: STATE.settings.minimumRatings,
		useBrandWhitelist: STATE.settings.useBrandWhitelist,
		hideSponsoredResults: STATE.settings.hideSponsoredResults,
		whitelistAvailable: whitelistCount > 0,
		whitelistCount,
		...summarizeResults(container),
	});

	notifyBadgeCount();
}

function scheduleApply(options = {}) {
	const fullRefresh = options.fullRefresh === true;

	if (fullRefresh) {
		STATE.rerunFullRefresh = true;
	}

	window.clearTimeout(STATE.applyTimerId);
	STATE.applyTimerId = window.setTimeout(() => {
		void applyFilters();
	}, 120);
}

function handleObservedCardChanges(cards, container) {
	if (!cards.length) {
		refreshPageSummary(container);
		return;
	}

	if (STATE.isApplying) {
		scheduleApply({ fullRefresh: true });
		return;
	}

	applyProductFiltersToCards(cards);
	applyStandaloneSponsoredBlocks(container);
	refreshPageSummary(container);
}

function mutationAddsStandaloneSponsoredModule(mutation) {
	for (const node of mutation.addedNodes) {
		if (!(node instanceof Element)) {
			continue;
		}

		if (
			matchesSelectorOrDescendant(node, SPONSORED_SIGNAL_SELECTOR) ||
			matchesSelectorOrDescendant(node, SPONSORED_LINK_SELECTOR)
		) {
			return true;
		}
	}

	return false;
}

function ensureResultsObserver(container) {
	if (!container) {
		disconnectResultsObserver();
		return;
	}

	if (STATE.observedContainer === container && STATE.resultsObserver) {
		return;
	}

	disconnectResultsObserver();
	STATE.observedContainer = container;
	STATE.resultsObserver = new MutationObserver((mutations) => {
		const changedCards = new Set();
		let needsFullRefresh = false;
		let sawRemoval = false;

		for (const mutation of mutations) {
			if (mutation.type !== "childList") {
				continue;
			}

			if (mutation.removedNodes.length > 0) {
				sawRemoval = true;
			}

			if (mutation.target instanceof Element) {
				const owningCard = mutation.target.closest(RESULT_CARD_SELECTOR);

				if (owningCard) {
					cache.sponsored.delete(owningCard);
					changedCards.add(owningCard);
				}
			}

			for (const node of mutation.addedNodes) {
				if (!(node instanceof Element)) {
					continue;
				}

				if (node.matches(RESULTS_CONTAINER_SELECTOR)) {
					needsFullRefresh = true;
					break;
				}

				if (mutationAddsStandaloneSponsoredModule(mutation)) {
					needsFullRefresh = true;
					break;
				}

				for (const card of getSearchResultCards(node)) {
					cache.sponsored.delete(card);
					changedCards.add(card);
				}
			}

			if (needsFullRefresh) {
				break;
			}
		}

		if (needsFullRefresh) {
			scheduleApply({ fullRefresh: true });
			return;
		}

		if (changedCards.size > 0) {
			handleObservedCardChanges(Array.from(changedCards), container);
			return;
		}

		if (sawRemoval) {
			refreshPageSummary(container);
		}
	});

	STATE.resultsObserver.observe(container, {
		childList: true,
		subtree: true,
	});
}

function handleNavigationChange() {
	const locationChanged = window.location.href !== STATE.locationHref;
	const currentContainer = findResultsContainer();

	if (!locationChanged && currentContainer === STATE.observedContainer) {
		return;
	}

	STATE.locationHref = window.location.href;
	cache.sponsored = new WeakMap();
	resetPrimeTokenCache();

	if (currentContainer !== STATE.observedContainer) {
		disconnectResultsObserver();
	}

	scheduleApply({ fullRefresh: true });
}

function observeNavigationChanges() {
	const wrapHistoryMethod = (methodName) => {
		const originalMethod = history[methodName];

		if (typeof originalMethod !== "function") {
			return;
		}

		history[methodName] = function wrappedHistoryMethod(...args) {
			const result = originalMethod.apply(this, args);
			queueMicrotask(handleNavigationChange);
			return result;
		};
	};

	wrapHistoryMethod("pushState");
	wrapHistoryMethod("replaceState");

	window.addEventListener("popstate", handleNavigationChange);
	window.addEventListener("hashchange", handleNavigationChange);
	window.addEventListener("pageshow", handleNavigationChange);
	window.addEventListener("load", handleNavigationChange, { once: true });

	STATE.navigationPollId = window.setInterval(
		handleNavigationChange,
		NAVIGATION_CHECK_INTERVAL_MS,
	);
}

function observeSettingsChanges() {
	extensionApi.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") {
			return;
		}

		let settingsChanged = false;
		const nextSettings = { ...STATE.settings };

		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			if (!(key in changes)) {
				continue;
			}

			nextSettings[key] = changes[key].newValue;
			settingsChanged = true;
		}

		if ("brandWhitelist" in changes) {
			STATE.brandWhitelist = normalizeBrandWhitelist(
				changes.brandWhitelist.newValue,
			);
			STATE.brandIndex = null;
		}

		if (!settingsChanged && !("brandWhitelist" in changes)) {
			return;
		}

		STATE.settings = sanitizeSettings(nextSettings);

		if ("hideSponsoredResults" in changes) {
			cache.sponsored = new WeakMap();
		}

		if (!STATE.settings.useBrandWhitelist) {
			STATE.brandIndex = null;
		}

		scheduleApply({ fullRefresh: true });
	});
}

function registerMessageHandlers() {
	extensionApi.runtime.onMessage.addListener(
		(message, _sender, sendResponse) => {
			if (message?.type !== "prime-rank-filter:get-page-status") {
				return undefined;
			}

			sendResponse({ ...STATE.pageStatus });
			return undefined;
		},
	);
}

async function applyFilters() {
	if (STATE.isApplying) {
		STATE.rerunRequested = true;
		return;
	}

	STATE.isApplying = true;
	const shouldRunFullRefresh = STATE.rerunFullRefresh;
	STATE.rerunFullRefresh = false;

	try {
		if (!STATE.settings.enabled) {
			resetProductFilters();
			disconnectResultsObserver();
			return;
		}

		const redirected = ensureCanonicalSearchUrl();

		if (redirected) {
			return;
		}

		const container = findResultsContainer();

		if (!container) {
			updatePageStatus({
				enabled: true,
				supportedPage: false,
			});
			disconnectResultsObserver();
			return;
		}

		ensureResultsObserver(container);

		if (shouldRunFullRefresh || !STATE.pageStatus.lastUpdatedAt) {
			applyProductFiltersToCards(getSearchResultCards(container));
		}

		applyStandaloneSponsoredBlocks(container);
		refreshPageSummary(container);
	} finally {
		STATE.isApplying = false;

		if (STATE.rerunRequested || STATE.rerunFullRefresh) {
			STATE.rerunRequested = false;
			scheduleApply({ fullRefresh: STATE.rerunFullRefresh });
		}
	}
}

async function init() {
	const storedValues = await extensionApi.storage.local.get({
		...DEFAULT_SETTINGS,
		...DEFAULT_STORAGE_STATE,
	});

	STATE.settings = sanitizeSettings(storedValues);
	STATE.brandWhitelist = normalizeBrandWhitelist(storedValues.brandWhitelist);

	observeSettingsChanges();
	observeNavigationChanges();
	registerMessageHandlers();

	scheduleApply({ fullRefresh: true });
}

init().catch((error) => {
	console.error(
		"Prime Rank Filter content script failed to initialize.",
		error,
	);
});
