const extensionApi = globalThis.browser ?? globalThis.chrome;
const { DEFAULT_SETTINGS, sanitizeSettings } = globalThis.PrimeRankShared;

const elements = {
	enabled: document.getElementById("enabled"),
	minimumRatings: document.getElementById("minimumRatings"),
	hideSponsoredResults: document.getElementById("hideSponsoredResults"),
	useBrandWhitelist: document.getElementById("useBrandWhitelist"),
	refreshWhitelist: document.getElementById("refreshWhitelist"),
	status: document.getElementById("status"),
	pageStatus: document.getElementById("pageStatus"),
	whitelistCount: document.getElementById("whitelistCount"),
	whitelistSource: document.getElementById("whitelistSource"),
	whitelistFetchedAt: document.getElementById("whitelistFetchedAt"),
	whitelistSyncStatus: document.getElementById("whitelistSyncStatus"),
	whitelistError: document.getElementById("whitelistError"),
};

let currentSettings = { ...DEFAULT_SETTINGS };
let refreshInFlight = false;

function areSettingsEqual(left, right) {
	return Object.keys(DEFAULT_SETTINGS).every((key) => left[key] === right[key]);
}

function formatTimestamp(timestamp) {
	const numericTimestamp = Number(timestamp || 0);

	if (!numericTimestamp) {
		return "Not yet";
	}

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(numericTimestamp));
}

function renderSettings(settings) {
	elements.enabled.checked = settings.enabled;
	elements.minimumRatings.value = String(settings.minimumRatings);
	elements.hideSponsoredResults.checked = settings.hideSponsoredResults;
	elements.useBrandWhitelist.checked = settings.useBrandWhitelist;
}

function renderSettingsStatus(settings, prefix = "Saved") {
	if (!settings.enabled) {
		elements.status.textContent = `${prefix}: extension off. Amazon pages stay untouched until you re-enable it.`;
		return;
	}

	const sponsoredStatus = settings.hideSponsoredResults
		? "sponsored blocking on"
		: "sponsored blocking off";
	const whitelistStatus = settings.useBrandWhitelist
		? "brand whitelist on"
		: "brand whitelist off";
	elements.status.textContent =
		`${prefix}: hide products under ${settings.minimumRatings} reviews · ` +
		`${sponsoredStatus} · ${whitelistStatus}.`;
}

function collectSettings() {
	return sanitizeSettings({
		enabled: elements.enabled.checked,
		minimumRatings: elements.minimumRatings.value,
		hideSponsoredResults: elements.hideSponsoredResults.checked,
		useBrandWhitelist: elements.useBrandWhitelist.checked,
	});
}

async function persistSettings() {
	const nextSettings = collectSettings();
	renderSettings(nextSettings);

	if (areSettingsEqual(nextSettings, currentSettings)) {
		renderSettingsStatus(nextSettings, "Unchanged");
		await loadPageStatus();
		return;
	}

	await extensionApi.storage.local.set(nextSettings);
	currentSettings = nextSettings;
	renderSettingsStatus(nextSettings);
	await loadPageStatus();
}

function renderWhitelistStatus(status) {
	if (status?.error) {
		elements.whitelistError.textContent = status.error;
		return;
	}

	elements.whitelistCount.textContent = Number(
		status?.count || 0,
	).toLocaleString();
	elements.whitelistSource.textContent = status?.source || "Unavailable";
	elements.whitelistFetchedAt.textContent = formatTimestamp(status?.fetchedAt);
	elements.whitelistSyncStatus.textContent = status?.syncStatus || "idle";
	elements.whitelistError.textContent = status?.lastError
		? `Last refresh error: ${status.lastError}`
		: "";
}

function renderPageStatus(pageStatus) {
	if (!pageStatus) {
		elements.pageStatus.textContent =
			"Open an Amazon search results page to inspect filtering status.";
		elements.pageStatus.dataset.status = "none";
		return;
	}

	if (!pageStatus.enabled && pageStatus.supportedPage) {
		elements.pageStatus.textContent = `Extension off on this Amazon results page. ${pageStatus.totalCount} results currently visible.`;
		elements.pageStatus.dataset.status = "disabled";
		return;
	}

	if (!pageStatus.supportedPage) {
		elements.pageStatus.textContent =
			"Open an Amazon search results page to inspect filtering status.";
		elements.pageStatus.dataset.status = "unsupported";
		return;
	}

	const details = [
		`${pageStatus.visibleCount} shown`,
		`${pageStatus.hiddenCount} hidden`,
	];

	if (pageStatus.hiddenBySponsored > 0) {
		details.push(`${pageStatus.hiddenBySponsored} sponsored`);
	}

	if (pageStatus.hiddenSponsoredModules > 0) {
		details.push(`${pageStatus.hiddenSponsoredModules} sponsored modules`);
	}

	if (pageStatus.hiddenByRatings > 0) {
		details.push(`${pageStatus.hiddenByRatings} low-review`);
	}

	if (pageStatus.hiddenByBrand > 0) {
		details.push(`${pageStatus.hiddenByBrand} non-whitelist`);
	}

	const primeText =
		pageStatus.primeStatus === "missing-token"
			? "Prime filter unavailable on this page."
			: "Prime filter enforced.";

	elements.pageStatus.dataset.status =
		pageStatus.primeStatus === "missing-token" ? "warning" : "active";

	elements.pageStatus.textContent =
		`${details.join(" · ")}. ${primeText} ` +
		`Threshold ${pageStatus.minimumRatings}.`;
}

async function getActiveTabId() {
	if (!extensionApi.tabs?.query) {
		return null;
	}

	const tabs = await extensionApi.tabs.query({
		active: true,
		currentWindow: true,
	});

	return tabs?.[0]?.id ?? null;
}

async function loadPageStatus() {
	if (!extensionApi.tabs?.sendMessage) {
		renderPageStatus(null);
		return;
	}

	try {
		const activeTabId = await getActiveTabId();

		if (typeof activeTabId !== "number") {
			renderPageStatus(null);
			return;
		}

		const pageStatus = await extensionApi.tabs.sendMessage(activeTabId, {
			type: "prime-rank-filter:get-page-status",
		});
		renderPageStatus(pageStatus);
	} catch {
		renderPageStatus(null);
	}
}

async function loadWhitelistStatus() {
	const whitelistStatus = await extensionApi.runtime.sendMessage({
		type: "prime-rank-filter:get-whitelist-status",
	});
	renderWhitelistStatus(whitelistStatus);
}

async function refreshWhitelist() {
	if (refreshInFlight) {
		return;
	}

	refreshInFlight = true;
	elements.refreshWhitelist.disabled = true;
	elements.refreshWhitelist.textContent = "Refreshing";

	try {
		const whitelistStatus = await extensionApi.runtime.sendMessage({
			type: "prime-rank-filter:refresh-brand-whitelist",
		});
		renderWhitelistStatus(whitelistStatus);
	} catch (error) {
		renderWhitelistStatus({
			error: error?.message || String(error),
		});
	} finally {
		refreshInFlight = false;
		elements.refreshWhitelist.disabled = false;
		elements.refreshWhitelist.textContent = "Refresh";
	}
}

function observeStorageChanges() {
	extensionApi.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") {
			return;
		}

		let settingsChanged = false;
		const nextSettings = { ...currentSettings };

		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			if (!(key in changes)) {
				continue;
			}

			nextSettings[key] = changes[key].newValue;
			settingsChanged = true;
		}

		if (settingsChanged) {
			currentSettings = sanitizeSettings(nextSettings);
			renderSettings(currentSettings);
			renderSettingsStatus(currentSettings, "Updated");
			void loadPageStatus();
		}

		if (
			"brandWhitelist" in changes ||
			"brandWhitelistFetchedAt" in changes ||
			"brandWhitelistSource" in changes ||
			"brandWhitelistLastError" in changes ||
			"brandWhitelistSyncStatus" in changes
		) {
			void loadWhitelistStatus();
		}
	});
}

async function init() {
	const storedSettings = await extensionApi.storage.local.get(DEFAULT_SETTINGS);
	currentSettings = sanitizeSettings(storedSettings);

	renderSettings(currentSettings);
	renderSettingsStatus(currentSettings, "Loaded");

	elements.enabled.addEventListener("change", persistSettings);
	elements.minimumRatings.addEventListener("change", persistSettings);
	elements.minimumRatings.addEventListener("blur", persistSettings);
	elements.hideSponsoredResults.addEventListener("change", persistSettings);
	elements.useBrandWhitelist.addEventListener("change", persistSettings);
	elements.refreshWhitelist.addEventListener("click", refreshWhitelist);

	observeStorageChanges();

	await Promise.all([loadWhitelistStatus(), loadPageStatus()]);
}

init().catch((error) => {
	console.error("Review Rank popup failed to initialize.", error);
	elements.status.textContent = "Unable to load extension settings.";
});
