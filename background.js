if (typeof importScripts === "function") {
	try {
		importScripts("prime-rank-shared.js", "amazon-brand-whitelist.js");
	} catch (error) {
		console.error("Prime Rank Filter background imports failed.", error);
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
			rawState.brandWhitelistSource || (whitelist.length ? "bundled" : "unavailable"),
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

async function fetchRemoteBrandWhitelist() {
	const response = await fetch(BRAND_WHITELIST_URL, {
		cache: "no-store",
	});

	if (!response.ok) {
		throw new Error(`Whitelist fetch failed with status ${response.status}.`);
	}

	return parseBrandWhitelist(await response.text());
}

async function syncBrandWhitelist(options = {}) {
	if (activeSyncPromise) {
		return activeSyncPromise;
	}

	activeSyncPromise = (async () => {
		const force = options.force === true;
		const attemptAt = Date.now();
		const storedState = await getStoredWhitelistState();
		const currentWhitelist = normalizeBrandWhitelist(storedState.brandWhitelist);

		if (!currentWhitelist.length) {
			await ensureBundledWhitelistFallback();
		}

		const latestState = await getStoredWhitelistState();

		if (
			!force &&
			!shouldRefreshBrandWhitelist({
				brandWhitelist: latestState.brandWhitelist,
				brandWhitelistFetchedAt: latestState.brandWhitelistFetchedAt,
			})
		) {
			return buildWhitelistStatus(latestState);
		}

		await extensionApi.storage.local.set({
			brandWhitelistLastAttemptAt: attemptAt,
			brandWhitelistLastError: "",
			brandWhitelistSyncStatus: "syncing",
		});

		try {
			const remoteWhitelist = await fetchRemoteBrandWhitelist();

			if (!remoteWhitelist.length) {
				throw new Error("Whitelist fetch returned an empty list.");
			}

			const nextState = {
				brandWhitelist: remoteWhitelist,
				brandWhitelistFetchedAt: attemptAt,
				brandWhitelistSource: "remote",
				brandWhitelistLastAttemptAt: attemptAt,
				brandWhitelistLastError: "",
				brandWhitelistSyncStatus: "idle",
			};

			await extensionApi.storage.local.set(nextState);
			return buildWhitelistStatus(nextState);
		} catch (error) {
			console.error("Prime Rank Filter whitelist sync failed.", error);

			if (!currentWhitelist.length) {
				await writeBundledWhitelist({
					loadedAt: attemptAt,
					lastError: error?.message || String(error),
					syncStatus: "error",
				});
			} else {
				await extensionApi.storage.local.set({
					brandWhitelistLastAttemptAt: attemptAt,
					brandWhitelistLastError: error?.message || String(error),
					brandWhitelistSyncStatus: "error",
				});
			}

			return buildWhitelistStatus(await getStoredWhitelistState());
		}
	})().finally(() => {
		activeSyncPromise = null;
	});

	return activeSyncPromise;
}

function ensureRefreshAlarm() {
	if (!extensionApi.alarms?.create) {
		return;
	}

	extensionApi.alarms.create(BRAND_WHITELIST_ALARM, {
		delayInMinutes: 24 * 60,
		periodInMinutes: 24 * 60,
	});
}

function registerRuntimeHandlers() {
	extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (
			message?.type !== "prime-rank-filter:get-whitelist-status" &&
			message?.type !== "prime-rank-filter:refresh-brand-whitelist"
		) {
			return undefined;
		}

		const run = async () => {
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
		};

		run()
			.then((response) => {
				sendResponse(response);
			})
			.catch((error) => {
				sendResponse({
					error: error?.message || String(error),
				});
			});

		return true;
	});
}

extensionApi.runtime.onInstalled.addListener(() => {
	void ensureBundledWhitelistFallback();
	void syncBrandWhitelist({ force: true });
	ensureRefreshAlarm();
});

if (extensionApi.runtime.onStartup?.addListener) {
	extensionApi.runtime.onStartup.addListener(() => {
		void ensureBundledWhitelistFallback();
		void syncBrandWhitelist();
		ensureRefreshAlarm();
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

registerRuntimeHandlers();
void ensureBundledWhitelistFallback();
void syncBrandWhitelist();
ensureRefreshAlarm();
