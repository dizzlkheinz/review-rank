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

function createControlledMutationObserverSet() {
	const observers = [];

	class ControlledMutationObserver {
		constructor(callback) {
			this.callback = callback;
			this.options = null;
			this.target = null;
			this.disconnected = false;
			observers.push(this);
		}

		observe(target, options) {
			this.target = target;
			this.options = options;
			this.disconnected = false;
		}

		disconnect() {
			this.disconnected = true;
		}

		takeRecords() {
			return [];
		}

		dispatch(records) {
			if (!this.disconnected) {
				this.callback(records, this);
			}
		}
	}

	return { MutationObserver: ControlledMutationObserver, observers };
}

function createTestWindow(html, url, replacedUrls, MutationObserver) {
	const { document, window: domWindow } = parseHTML(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
	);

	// LinkeDOM's window setters write to Node globals. Keep browser state local
	// so observers and timers from another test cannot navigate this page.
	const window = {
		setTimeout,
		clearTimeout,
		queueMicrotask,
		console,
		URL,
		Element: domWindow.Element,
		MutationObserver: MutationObserver || domWindow.MutationObserver,
		addEventListener: domWindow.addEventListener,
		removeEventListener: domWindow.removeEventListener,
		dispatchEvent: domWindow.dispatchEvent,
		location: {
			href: url,
			replace(nextUrl) {
				replacedUrls.push(nextUrl);
				this.href = nextUrl;
			},
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
	const {
		html = fixtureHtml,
		storage = {},
		url = DEFAULT_TEST_URL,
		mutationObserverSet,
	} = options;
	const storageData = { ...storage };
	const sentMessages = [];
	const runtimeMessageListeners = [];
	const storageChangeListeners = [];
	const replacedUrls = [];
	const { document, window } = createTestWindow(
		html,
		url,
		replacedUrls,
		mutationObserverSet?.MutationObserver,
	);
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
		mutationObserverSet,
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

function dispatchResultMutation(env, record) {
	const observer = env.mutationObserverSet?.observers.find(
		(candidate) => candidate.options?.characterData,
	);
	assert.ok(observer, "results mutation observer should be installed");
	observer.dispatch([record]);
}

async function runContentScript(options = {}) {
	const env = createTestEnv(options);
	executeContentScript(env);
	await waitFor(220);
	return env;
}

function getPageStatus(env) {
	return new Promise((resolve, reject) => {
		if (!env.runtimeMessageListeners.length) {
			reject(new Error("content script registered no message handler"));
			return;
		}

		for (const listener of env.runtimeMessageListeners) {
			listener({ type: "prime-rank-filter:get-page-status" }, {}, resolve);
		}
	});
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

test("shipped script applies fixture filters to organic, low-review, and sponsored cards", async () => {
	const env = await runContentScript();
	const cases = [
		["B000TEST01", "visible", "organic", ""],
		["B000TEST02", "hidden", "organic", "low-reviews"],
		["B000TEST03", "hidden", "sponsored", "sponsored"],
		["B000TEST04", "hidden", "sponsored", "sponsored"],
		["B000TEST05", "hidden", "organic", "low-reviews"],
		["B000TEST06", "hidden", "sponsored", "sponsored"],
	];

	for (const [asin, filter, sponsored, reason] of cases) {
		const card = env.document.querySelector(`[data-asin='${asin}']`);
		assert.equal(card.dataset.primeRankFilter, filter, asin);
		assert.equal(card.dataset.primeRankSponsored, sponsored, asin);
		assert.equal(card.dataset.primeRankHiddenReasons, reason, asin);
	}
});

test("shipped script updates review thresholds, sponsored blocking, and brand filtering", async () => {
	const env = await runContentScript();
	const card = (asin) => env.document.querySelector(`[data-asin='${asin}']`);
	await env.extensionApi.storage.local.set({
		minimumRatings: 0,
		hideSponsoredResults: false,
	});
	await waitFor(220);
	for (const asin of ["B000TEST02", "B000TEST03", "B000TEST05"]) {
		assert.equal(card(asin).dataset.primeRankFilter, "visible", asin);
	}
	await env.extensionApi.storage.local.set({
		useBrandWhitelist: true,
		brandWhitelist: ["Samsung", "Apple", "Sony"],
	});
	await waitFor(220);
	assert.equal(card("B000TEST01").dataset.primeRankFilter, "visible");
	assert.equal(card("B000TEST01").dataset.primeRankBrand, "Samsung");
	assert.equal(card("B000TEST02").dataset.primeRankFilter, "hidden");
	assert.equal(card("B000TEST02").dataset.primeRankHiddenReasons, "brand");
});

test("shipped script fails open when brand filtering has an empty whitelist", async () => {
	const env = await runContentScript({
		storage: { useBrandWhitelist: true, brandWhitelist: [] },
	});
	const card = env.document.querySelector("[data-asin='B000TEST01']");

	assert.equal(card.dataset.primeRankFilter, "visible");
	assert.equal(card.dataset.primeRankHiddenReasons, "");
});

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

test("content script canonicalizes after cards enter an initially empty results container", async () => {
	const env = await runContentScript({
		html: '<div class="s-main-slot s-result-list"></div>',
		url: "https://www.amazon.ca/s?k=goartea",
	});
	const container = env.document.querySelector(".s-main-slot");
	assert.deepEqual(env.replacedUrls, [], "empty results do not redirect yet");
	container.innerHTML =
		'<div data-component-type="s-search-result" data-asin="LATE01"><h2>Goartea</h2></div>';
	await waitFor(250);

	assert.equal(
		env.replacedUrls.length,
		1,
		"late results trigger canonicalization",
	);
	assert.match(env.replacedUrls[0], /p_85%3A5690392011/);
	assert.match(env.replacedUrls[0], /s=review-rank/);
	const status = await getPageStatus(env);
	assert.equal(status.primeStatus, "enforced");
	assert.equal(status.sortStatus, "review-rank");
});

for (const title of ["Sponsored: A Memoir", "Unsponsored: A Memoir"]) {
	test(`organic title ${JSON.stringify(title)} does not trigger sponsored filtering`, async () => {
		const env = await runContentScript();
		const card = env.document.querySelector("[data-asin='B000TEST01']");
		card.querySelector("h2").textContent = title;
		await waitFor(250);

		assert.equal(card.dataset.primeRankFilter, "visible");
		assert.equal(card.dataset.primeRankSponsored, "organic");
	});
}

for (const [minimumRatings, expectedFilter] of [
	[1000, "visible"],
	[1500, "hidden"],
]) {
	test(`shipped script parses 1.2K reviews at a threshold of ${minimumRatings}`, async () => {
		const html = fixtureHtml.replace("12,345", "1.2K");
		const env = await runContentScript({
			html,
			storage: { minimumRatings },
		});
		const card = env.document.querySelector("[data-asin='B000TEST01']");

		assert.equal(card.dataset.primeRankReviewCount, "1200");
		assert.equal(card.dataset.primeRankFilter, expectedFilter);
	});
}

test("standalone sponsored modules outside results are observed and restored when disabled", async () => {
	const env = await runContentScript();
	const results = env.document.querySelector(".s-main-slot");
	const fixtureModule = env.document.querySelector(
		"[data-component-type='s-impression-logger'] .sg-col-inner",
	);
	const module = env.document.createElement("div");
	module.className = "sg-col-inner";
	module.innerHTML = '<div class="ad-signal">An ad</div>';
	env.document.body.append(module);
	await waitFor(40);
	assert.equal(module.dataset.primeRankSponsoredModule, undefined);

	module
		.querySelector(".ad-signal")
		.setAttribute("data-ad-feedback-label-id", "sponsored-label");
	await waitFor(250);

	assert.equal(module.dataset.primeRankSponsoredModule, "hidden");
	assert.equal(module.style.getPropertyValue("display"), "none");
	assert.equal(fixtureModule.dataset.primeRankSponsoredModule, "hidden");
	assert.ok(!results.style.getPropertyValue("display"));

	await env.extensionApi.storage.local.set({ hideSponsoredResults: false });
	await waitFor(250);
	assert.equal(module.dataset.primeRankSponsoredModule, undefined);
	assert.ok(!module.style.getPropertyValue("display"));
	assert.equal(fixtureModule.dataset.primeRankSponsoredModule, undefined);
	assert.ok(!fixtureModule.style.getPropertyValue("display"));

	await env.extensionApi.storage.local.set({ hideSponsoredResults: true });
	await waitFor(250);
	assert.equal(module.dataset.primeRankSponsoredModule, "hidden");
	assert.equal(fixtureModule.dataset.primeRankSponsoredModule, "hidden");

	await env.extensionApi.storage.local.set({ enabled: false });
	await waitFor(250);
	assert.equal(module.dataset.primeRankSponsoredModule, undefined);
	assert.ok(!module.style.getPropertyValue("display"));
	assert.equal(fixtureModule.dataset.primeRankSponsoredModule, undefined);
	assert.ok(!fixtureModule.style.getPropertyValue("display"));
});

test("standalone modules are restored when their last sponsored signal disappears", async () => {
	const mutationObserverSet = createControlledMutationObserverSet();
	const html = `${fixtureHtml}
		<div class="sg-col-inner" id="attribute-ad">
			<span id="attribute-signal" data-ad-feedback-label-id="sponsored-label">Ad</span>
		</div>
		<div class="sg-col-inner" id="removed-subtree-ad">
			<span id="removed-signal" data-ad-feedback-label-id="sponsored-label">Ad</span>
		</div>
		<div class="sg-col-inner" id="recycled-ad">
			<span id="recycled-signal" data-ad-feedback-label-id="sponsored-label">Ad</span>
		</div>`;
	const env = await runContentScript({ html, mutationObserverSet });
	const attributeModule = env.document.getElementById("attribute-ad");
	const attributeSignal = env.document.getElementById("attribute-signal");
	const subtreeModule = env.document.getElementById("removed-subtree-ad");
	const removedSignal = env.document.getElementById("removed-signal");
	const recycledModule = env.document.getElementById("recycled-ad");
	const recycledSignal = env.document.getElementById("recycled-signal");
	const fixtureModule = env.document.querySelector(
		"[data-component-type='s-impression-logger'] .sg-col-inner",
	);
	const lowReviewCard = env.document.querySelector("[data-asin='B000TEST02']");

	assert.equal(attributeModule.dataset.primeRankSponsoredModule, "hidden");
	assert.equal(subtreeModule.dataset.primeRankSponsoredModule, "hidden");

	attributeSignal.removeAttribute("data-ad-feedback-label-id");
	dispatchResultMutation(env, {
		type: "attributes",
		target: attributeSignal,
		attributeName: "data-ad-feedback-label-id",
	});
	await waitFor(250);
	assert.equal(
		attributeModule.dataset.primeRankSponsoredModule,
		undefined,
		"removing the final signal attribute restores its module",
	);
	assert.ok(!attributeModule.style.getPropertyValue("display"));

	removedSignal.remove();
	dispatchResultMutation(env, {
		type: "childList",
		target: subtreeModule,
		addedNodes: [],
		removedNodes: [removedSignal],
	});
	recycledSignal.remove();
	recycledModule.dataset.componentType = "s-search-result";
	recycledModule.dataset.asin = "RECYCLEDLOW";
	recycledModule.innerHTML = `<h2><span>Reused low review result</span></h2>
		<a href="/product-reviews/RECYCLEDLOW/customerReviews"><span class="s-underline-text">42</span></a>`;
	dispatchResultMutation(env, {
		type: "attributes",
		target: recycledModule,
		attributeName: "data-component-type",
	});
	dispatchResultMutation(env, {
		type: "attributes",
		target: recycledModule,
		attributeName: "data-asin",
	});
	await waitFor(250);

	for (const module of [attributeModule, subtreeModule]) {
		assert.equal(module.dataset.primeRankSponsoredModule, undefined);
		assert.ok(!module.style.getPropertyValue("display"));
	}
	assert.equal(fixtureModule.dataset.primeRankSponsoredModule, "hidden");
	assert.equal(fixtureModule.style.getPropertyValue("display"), "none");
	assert.equal(lowReviewCard.dataset.primeRankFilter, "hidden");
	assert.equal(lowReviewCard.style.getPropertyValue("display"), "none");
	assert.equal(recycledModule.dataset.primeRankSponsoredModule, undefined);
	assert.equal(recycledModule.dataset.primeRankFilter, "hidden");
	assert.equal(recycledModule.style.getPropertyValue("display"), "none");
});

test("card-contained signal and media markers still identify sponsored results", async () => {
	const env = await runContentScript({
		html: `<div class="s-main-slot s-result-list">
			<div data-component-type="s-search-result" data-asin="SIGNAL01">
				<h2><span>Signal ad</span></h2>
				<a href="/product-reviews/SIGNAL01/customerReviews"><span class="s-underline-text">1,200</span></a>
				<span data-ad-feedback-label-id="sponsored-label">Ad</span>
			</div>
			<div data-component-type="s-search-result" data-asin="MEDIA01">
				<h2><span>Media ad</span></h2>
				<a href="/product-reviews/MEDIA01/customerReviews"><span class="s-underline-text">1,200</span></a>
				<img alt="Sponsored Ad">
			</div>
		</div>`,
	});

	for (const asin of ["SIGNAL01", "MEDIA01"]) {
		const card = env.document.querySelector(`[data-asin='${asin}']`);
		assert.equal(card.dataset.primeRankFilter, "hidden", asin);
		assert.ok(card.dataset.primeRankHiddenReasons.includes("sponsored"), asin);
		assert.equal(card.dataset.primeRankSponsoredModule, undefined, asin);
	}
});

test("nested Amazon item wrappers follow their inner result rating mutations", async () => {
	const mutationObserverSet = createControlledMutationObserverSet();
	const html = `<div class="s-main-slot s-result-list">
		<div class="s-widget-container" data-csa-c-type="item" data-csa-c-item-id="amzn1.asin.B000NEST01">
			<div data-component-type="s-search-result" data-asin="B000NEST01">
				<h2><a><span>Samsung headphones</span></a></h2>
				<a href="/product-reviews/B000NEST01/customerReviews"><span class="s-underline-text">42</span></a>
			</div>
		</div>
	</div>`;
	const env = await runContentScript({
		html,
		mutationObserverSet,
		storage: { minimumRatings: 500 },
	});
	const outer = env.document.querySelector(
		".s-widget-container[data-csa-c-item-id*='.asin']",
	);
	const count = outer.querySelector(".s-underline-text").firstChild;

	assert.equal(outer.dataset.primeRankFilter, "hidden");
	assert.equal(outer.dataset.primeRankReviewCount, "42");
	assert.equal(outer.style.getPropertyValue("display"), "none");

	count.nodeValue = "1,000";
	dispatchResultMutation(env, {
		type: "characterData",
		target: count,
	});
	await waitFor(250);
	assert.equal(outer.dataset.primeRankReviewCount, "1000");
	assert.equal(outer.dataset.primeRankFilter, "visible");
	assert.ok(!outer.style.getPropertyValue("display"));
	assert.ok(!outer.hasAttribute("aria-hidden"));

	count.nodeValue = "42";
	dispatchResultMutation(env, {
		type: "characterData",
		target: count,
	});
	await waitFor(250);
	assert.equal(outer.dataset.primeRankReviewCount, "42");
	assert.equal(outer.dataset.primeRankFilter, "hidden");
	assert.equal(outer.style.getPropertyValue("display"), "none");
	assert.equal(outer.getAttribute("aria-hidden"), "true");
});

test("badge counts five hidden cards and one standalone module", async () => {
	const env = await runContentScript();
	const status = await getPageStatus(env);
	const badgeUpdate = [...env.sentMessages]
		.reverse()
		.find((message) => message.type === "prime-rank-filter:update-badge");

	assert.equal(status.hiddenCount, 5);
	assert.equal(status.hiddenSponsoredModules, 1);
	assert.equal(badgeUpdate.hiddenCount, 6);
});

test("sponsored detection never hides a wrapper containing the results list", async () => {
	const env = await runContentScript({
		html: `<div class="sg-col-inner" id="layout">${fixtureHtml}<span data-ad-feedback-label-id="banner">Ad</span></div>`,
	});
	const layout = env.document.getElementById("layout");
	assert.equal(layout.dataset.primeRankSponsoredModule, undefined);
	assert.ok(!layout.style.getPropertyValue("display"));
	assert.equal(
		env.document.querySelector("[data-asin='B000TEST01']").dataset
			.primeRankFilter,
		"visible",
	);
});

test("a sponsored sibling banner does not hide the only organic result card", async () => {
	const env = await runContentScript({
		html: `<div class="s-main-slot s-result-list"><div class="sg-col-inner" id="shared-result-banner">
		<div data-component-type="s-search-result" data-asin="ORGANIC01">
			<h2><a><span>Samsung headphones</span></a></h2>
			<a href="/product-reviews/ORGANIC01/customerReviews"><span class="s-underline-text">1,234</span></a>
		</div>
		<div class="banner"><span data-ad-feedback-label-id="sponsored-label">Sponsored</span></div>
	</div><div class="sg-col-inner" id="separate-sponsored-ad"><span data-ad-feedback-label-id="sponsored-label">Sponsored ad</span></div></div>`,
	});
	const card = env.document.querySelector("[data-asin='ORGANIC01']");
	const sharedAncestor = env.document.getElementById("shared-result-banner");
	const separateAd = env.document.getElementById("separate-sponsored-ad");
	const status = await getPageStatus(env);

	assert.equal(card.dataset.primeRankFilter, "visible");
	assert.equal(card.dataset.primeRankSponsored, "organic");
	assert.ok(!card.style.getPropertyValue("display"));
	assert.ok(!card.hasAttribute("aria-hidden"));
	assert.equal(sharedAncestor.dataset.primeRankSponsoredModule, undefined);
	assert.ok(!sharedAncestor.style.getPropertyValue("display"));
	assert.equal(status.visibleCount, 1);
	assert.equal(status.hiddenCount, 0);
	assert.equal(separateAd.dataset.primeRankSponsoredModule, "hidden");
	assert.equal(separateAd.style.getPropertyValue("display"), "none");
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

const SELLER_FILTERED_CA_URL =
	"https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank";

test("content script enforces the measured prime facet on a seller-filtered page", async () => {
	const env = await runContentScript({ url: SELLER_FILTERED_CA_URL });

	assert.equal(env.replacedUrls.length, 1, "page should be redirected once");
	assert.match(env.replacedUrls[0], /p_85%3A5690392011/);
	assert.match(
		env.replacedUrls[0],
		/rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3%2Cp_85%3A5690392011/,
		"existing category and seller refinements survive",
	);
});

test("content script leaves urls alone when prime enforcement is off", async () => {
	const env = await runContentScript({
		url: SELLER_FILTERED_CA_URL,
		storage: { enforcePrime: false },
	});

	assert.deepEqual(
		env.replacedUrls,
		[],
		"no redirect when the page has no Prime facet",
	);

	const status = await getPageStatus(env);
	assert.equal(status.primeStatus, "disabled");
	assert.equal(status.enforcePrime, false);
});

test("content script learns a marketplace prime token from Amazon's own refinement link", async () => {
	const primeRefinementLink =
		'<a href="/s?k=kaffee&rh=n%3A340846031%2Cp_85%3A20943776031&ref=sr_nr_p_85_1">Prime</a>';
	const env = await runContentScript({
		html: `${primeRefinementLink}${fixtureHtml}`,
		url: "https://www.amazon.de/s?k=kaffee&s=review-rank",
	});

	assert.deepEqual(env.storageData.primeTokensByHost, {
		"www.amazon.de": "p_85:20943776031",
	});
	assert.equal(env.replacedUrls.length, 1);
	assert.match(env.replacedUrls[0], /rh=p_85%3A20943776031/);
});

test("content script reuses a learned token where Amazon hides the prime facet", async () => {
	const env = await runContentScript({
		url: "https://www.amazon.de/s?k=kaffee&i=grocery&rh=p_6%3AA2HMM5KJS65BH3&s=review-rank",
		storage: { primeTokensByHost: { "www.amazon.de": "p_85:20943776031" } },
	});

	assert.equal(env.replacedUrls.length, 1);
	assert.match(
		env.replacedUrls[0],
		/rh=p_6%3AA2HMM5KJS65BH3%2Cp_85%3A20943776031/,
	);
});

test("content script keeps a Prime facet already present when enforcement starts off", async () => {
	const env = await runContentScript({
		url: "https://www.amazon.ca/s?k=goartea&s=review-rank&rh=n%3A6967215011%2Cp_85%3A5690392011",
		storage: { enforcePrime: false },
	});

	assert.deepEqual(
		env.replacedUrls,
		[],
		"steady disabled state leaves manually chosen facet intact",
	);

	const status = await getPageStatus(env);
	assert.equal(status.primeStatus, "page-filtered");
	assert.equal(status.enforcePrime, false);
});

test("content script auto-reloads to drop prime facet when enforcePrime is toggled off in storage", async () => {
	const env = await runContentScript({
		url: "https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3%2Cp_85%3A5690392011&s=review-rank",
		storage: { enforcePrime: true },
	});

	assert.deepEqual(env.replacedUrls, [], "already has prime facet");

	await env.extensionApi.storage.local.set({ enforcePrime: false });
	await waitFor(200);

	assert.equal(env.replacedUrls.length, 1, "auto-reloads to drop prime facet");
	assert.equal(
		env.replacedUrls[0],
		"https://www.amazon.ca/s?k=goartea&i=grocery&rh=n%3A6967215011%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank",
	);
});

test("content script removes the Mexico Prime choice without dropping other refinements", async () => {
	const env = await runContentScript({
		url: "https://www.amazon.com.mx/s?k=ink&i=office&rh=n%3A123%2Cp_n_prime_domestic%3A217698801011%7C217698802011%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank",
		storage: { enforcePrime: true },
	});

	await env.extensionApi.storage.local.set({ enforcePrime: false });
	await waitFor(200);

	assert.equal(env.replacedUrls.length, 1);
	assert.equal(
		env.replacedUrls[0],
		"https://www.amazon.com.mx/s?k=ink&i=office&rh=n%3A123%2Cp_6%3AA2HMM5KJS65BH3&s=review-rank",
	);
});

test("one-time transition cleanup does not remove a later manual Prime selection", async () => {
	const env = await runContentScript({
		url: "https://www.amazon.ca/s?k=goartea&s=review-rank&rh=n%3A6967215011%2Cp_85%3A5690392011",
		storage: { enforcePrime: true },
	});

	await env.extensionApi.storage.local.set({ enforcePrime: false });
	await waitFor(200);
	assert.equal(
		env.replacedUrls.length,
		1,
		"the transition removes the existing facet once",
	);

	env.window.location.href =
		"https://www.amazon.ca/s?k=goartea&s=review-rank&rh=n%3A6967215011%2Cp_85%3A5690392011";
	await env.extensionApi.storage.local.set({ minimumRatings: 250 });
	await waitFor(200);

	assert.equal(
		env.replacedUrls.length,
		1,
		"a later settings update does not consume cleanup again",
	);
	assert.match(env.window.location.href, /p_85%3A5690392011/);
});
