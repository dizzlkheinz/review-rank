if (typeof importScripts === "function") {
	try {
		importScripts("prime-rank-shared.js", "amazon-brand-whitelist.js");
	} catch (error) {
		console.error("Review Rank background imports failed.", error);
	}
}

const extensionApi = globalThis.browser ?? globalThis.chrome;
const {
	BRAND_WHITELIST_MAX_AGE_MS,
	DEFAULT_STORAGE_STATE,
	normalizeBrandWhitelist,
	parseBrandWhitelist,
	shouldRefreshBrandWhitelist,
} = globalThis.PrimeRankShared;

const BRAND_WHITELIST_URL =
	"https://raw.githubusercontent.com/chris-mosley/AmazonBrandFilterList/main/brands.txt";
const BRAND_WHITELIST_ALARM = "prime-rank-filter-refresh-brand-whitelist";

let activeSyncPromise = null;

function getBundledBrandWhitelist() {
	return Array.isArray(globalThis.PRIME_RANK_BRAND_WHITELIST)
		? globalThis.PRIME_RANK_BRAND_WHITELIST
		: [];
}

async function getStoredWhitelistState() {
	return extensionApi.storage.local.get(DEFAULT_STORAGE_STATE);
}

function buildWhitelistStatus(rawState) {
	const whitelist = normalizeBrandWhitelist(rawState.brandWhitelist);

	return {
		count: whitelist.length,
		fetchedAt: Number(rawState.brandWhitelistFetchedAt || 0),
		source:
			rawState.brandWhitelistSource ||
			(whitelist.length ? "bundled" : "unavailable"),
		lastAttemptAt: Number(rawState.brandWhitelistLastAttemptAt || 0),
		lastError: String(rawState.brandWhitelistLastError || ""),
		syncStatus: String(rawState.brandWhitelistSyncStatus || "idle"),
		maxAgeMs: BRAND_WHITELIST_MAX_AGE_MS,
	};
}

async function writeBundledWhitelist(options = {}) {
	const loadedAt = Number(options.loadedAt || Date.now());
	const bundledWhitelist = normalizeBrandWhitelist(getBundledBrandWhitelist());

	if (!bundledWhitelist.length) {
		throw new Error("Bundled whitelist snapshot is empty.");
	}

	const nextState = {
		brandWhitelist: bundledWhitelist,
		brandWhitelistFetchedAt: loadedAt,
		brandWhitelistSource: "bundled",
		brandWhitelistLastAttemptAt: loadedAt,
		brandWhitelistLastError: options.lastError || "",
		brandWhitelistSyncStatus: options.syncStatus || "idle",
	};

	await extensionApi.storage.local.set(nextState);
	return buildWhitelistStatus(nextState);
}

async function ensureBundledWhitelistFallback() {
	const storedState = await getStoredWhitelistState();
	const currentWhitelist = normalizeBrandWhitelist(storedState.brandWhitelist);

	if (currentWhitelist.length > 0) {
		return buildWhitelistStatus(storedState);
	}

	return writeBundledWhitelist();
}

const WHITELIST_FETCH_TIMEOUT_MS = 30_000;
const WHITELIST_MAX_SIZE_BYTES = 1_048_576;

function assertWhitelistResponseOk(response) {
	if (!response.ok) {
		throw new Error(`Whitelist fetch failed with status ${response.status}.`);
	}
}

function assertWhitelistResponseSize(response) {
	const contentLength = Number(response.headers.get("content-length") || 0);

	if (contentLength > WHITELIST_MAX_SIZE_BYTES) {
		throw new Error(
			`Whitelist response too large: ${contentLength} bytes (max ${WHITELIST_MAX_SIZE_BYTES}).`,
		);
	}
}

function assertWhitelistBodySize(text) {
	if (text.length > WHITELIST_MAX_SIZE_BYTES) {
		throw new Error(
			`Whitelist body too large: ${text.length} characters (max ${WHITELIST_MAX_SIZE_BYTES}).`,
		);
	}
}

function warnOnSuspiciousWhitelist(brands) {
	if (brands.length > 0 && brands.length < 5) {
		console.warn(
			`Review Rank: whitelist suspiciously small (${brands.length} entries).`,
		);
	}
}

async function fetchRemoteBrandWhitelist() {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		WHITELIST_FETCH_TIMEOUT_MS,
	);

	try {
		const response = await fetch(BRAND_WHITELIST_URL, {
			cache: "no-store",
			signal: controller.signal,
		});

		assertWhitelistResponseOk(response);
		assertWhitelistResponseSize(response);
		const text = await response.text();
		assertWhitelistBodySize(text);
		const brands = parseBrandWhitelist(text);

		warnOnSuspiciousWhitelist(brands);
		return brands;
	} finally {
		clearTimeout(timeoutId);
	}
}

function shouldSkipWhitelistSync(force, state) {
	return (
		!force &&
		!shouldRefreshBrandWhitelist({
			brandWhitelist: state.brandWhitelist,
			brandWhitelistFetchedAt: state.brandWhitelistFetchedAt,
		})
	);
}

async function markWhitelistSyncAttempt(attemptAt) {
	await extensionApi.storage.local.set({
		brandWhitelistLastAttemptAt: attemptAt,
		brandWhitelistLastError: "",
		brandWhitelistSyncStatus: "syncing",
	});
}

function buildRemoteWhitelistState(remoteWhitelist, attemptAt) {
	return {
		brandWhitelist: remoteWhitelist,
		brandWhitelistFetchedAt: attemptAt,
		brandWhitelistSource: "remote",
		brandWhitelistLastAttemptAt: attemptAt,
		brandWhitelistLastError: "",
		brandWhitelistSyncStatus: "idle",
	};
}

async function fetchUsableRemoteWhitelist() {
	const remoteWhitelist = await fetchRemoteBrandWhitelist();

	if (!remoteWhitelist.length) {
		throw new Error("Whitelist fetch returned an empty list.");
	}

	return remoteWhitelist;
}

async function writeRemoteWhitelist(remoteWhitelist, attemptAt) {
	const nextState = buildRemoteWhitelistState(remoteWhitelist, attemptAt);
	await extensionApi.storage.local.set(nextState);
	return buildWhitelistStatus(nextState);
}

function getErrorMessage(error) {
	return error?.message || String(error);
}

async function recordWhitelistSyncFailure(error, currentWhitelist, attemptAt) {
	const lastError = getErrorMessage(error);

	if (!currentWhitelist.length) {
		return writeBundledWhitelist({
			loadedAt: attemptAt,
			lastError,
			syncStatus: "error",
		});
	}

	await extensionApi.storage.local.set({
		brandWhitelistLastAttemptAt: attemptAt,
		brandWhitelistLastError: lastError,
		brandWhitelistSyncStatus: "error",
	});

	return buildWhitelistStatus(await getStoredWhitelistState());
}

async function runBrandWhitelistSync(options = {}) {
	const force = options.force === true;
	const attemptAt = Date.now();
	const storedState = await getStoredWhitelistState();
	const currentWhitelist = normalizeBrandWhitelist(storedState.brandWhitelist);

	if (!currentWhitelist.length) {
		await ensureBundledWhitelistFallback();
	}

	const latestState = await getStoredWhitelistState();

	if (shouldSkipWhitelistSync(force, latestState)) {
		return buildWhitelistStatus(latestState);
	}

	await markWhitelistSyncAttempt(attemptAt);

	try {
		return writeRemoteWhitelist(await fetchUsableRemoteWhitelist(), attemptAt);
	} catch (error) {
		console.error("Review Rank whitelist sync failed.", error);
		return recordWhitelistSyncFailure(error, currentWhitelist, attemptAt);
	}
}

async function syncBrandWhitelist(options = {}) {
	if (activeSyncPromise) {
		return activeSyncPromise;
	}

	activeSyncPromise = runBrandWhitelistSync(options).finally(() => {
		activeSyncPromise = null;
	});

	return activeSyncPromise;
}

async function recoverStaleSyncStatus() {
	const state = await getStoredWhitelistState();

	if (state.brandWhitelistSyncStatus === "syncing") {
		await extensionApi.storage.local.set({
			brandWhitelistSyncStatus: "error",
			brandWhitelistLastError: "Sync interrupted by service worker restart.",
		});
	}
}

async function isBrandWhitelistEnabled() {
	const stored = await extensionApi.storage.local.get({
		useBrandWhitelist: false,
	});
	return stored.useBrandWhitelist === true;
}

async function initWhitelist(options = {}) {
	await recoverStaleSyncStatus();
	await ensureBundledWhitelistFallback();

	if (!options.force && !(await isBrandWhitelistEnabled())) {
		return buildWhitelistStatus(await getStoredWhitelistState());
	}

	return syncBrandWhitelist(options);
}

async function ensureRefreshAlarm() {
	if (!extensionApi.alarms?.create) {
		return;
	}

	if (await isBrandWhitelistEnabled()) {
		extensionApi.alarms.create(BRAND_WHITELIST_ALARM, {
			delayInMinutes: 24 * 60,
			periodInMinutes: 24 * 60,
		});
	} else if (extensionApi.alarms?.clear) {
		extensionApi.alarms.clear(BRAND_WHITELIST_ALARM);
	}
}

function getBadgeApi() {
	return extensionApi.action || extensionApi.browserAction;
}

function updateBadge(message, sender) {
	const badgeApi = getBadgeApi();

	if (!badgeApi) {
		return;
	}

	const tabId = sender?.tab?.id;
	const target = tabId ? { tabId } : {};

	if (!message.enabled || !message.supportedPage) {
		badgeApi.setBadgeText({ text: "", ...target });
		return;
	}

	if (message.hiddenCount > 0) {
		badgeApi.setBadgeText({
			text: String(message.hiddenCount),
			...target,
		});
		badgeApi.setBadgeBackgroundColor({ color: "#c45500", ...target });
	} else {
		badgeApi.setBadgeText({ text: "\u2713", ...target });
		badgeApi.setBadgeBackgroundColor({ color: "#2e7d32", ...target });
	}
}

function registerRuntimeHandlers() {
	extensionApi.runtime.onMessage.addListener(
		(message, _sender, sendResponse) => {
			if (message?.type === "prime-rank-filter:update-badge") {
				updateBadge(message, _sender);
				return undefined;
			}

			if (
				message?.type !== "prime-rank-filter:get-whitelist-status" &&
				message?.type !== "prime-rank-filter:refresh-brand-whitelist"
			) {
				return undefined;
			}

			handleWhitelistStatusMessage(message)
				.then((response) => {
					sendResponse(response);
				})
				.catch((error) => {
					sendResponse({
						error: error?.message || String(error),
					});
				});

			return true;
		},
	);
}

async function handleWhitelistStatusMessage(message) {
	switch (message?.type) {
		case "prime-rank-filter:get-whitelist-status":
			await ensureBundledWhitelistFallback();
			return buildWhitelistStatus(await getStoredWhitelistState());
		case "prime-rank-filter:refresh-brand-whitelist":
			return syncBrandWhitelist({
				force: true,
			});
		default:
			return undefined;
	}
}

extensionApi.runtime.onInstalled.addListener(() => {
	void initWhitelist({ force: true });
	void ensureRefreshAlarm();
});

if (extensionApi.runtime.onStartup?.addListener) {
	extensionApi.runtime.onStartup.addListener(() => {
		void initWhitelist();
		void ensureRefreshAlarm();
	});
}

if (extensionApi.alarms?.onAlarm?.addListener) {
	extensionApi.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name !== BRAND_WHITELIST_ALARM) {
			return;
		}

		void syncBrandWhitelist({ force: true });
	});
}

if (extensionApi.webNavigation?.onHistoryStateUpdated?.addListener) {
	extensionApi.webNavigation.onHistoryStateUpdated.addListener(
		(details) => {
			if (details.frameId !== 0) {
				return;
			}

			extensionApi.tabs
				.sendMessage(details.tabId, {
					type: "prime-rank-filter:navigation-changed",
				})
				.catch(() => {});
		},
		{
			url: [{ hostContains: ".amazon." }],
		},
	);
}

extensionApi.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local" || !("useBrandWhitelist" in changes)) {
		return;
	}

	void ensureRefreshAlarm();

	if (changes.useBrandWhitelist.newValue === true) {
		void syncBrandWhitelist();
	}
});

registerRuntimeHandlers();
void initWhitelist();
void ensureRefreshAlarm();
