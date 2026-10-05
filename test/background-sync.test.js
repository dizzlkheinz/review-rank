const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const backgroundSource = fs.readFileSync(
	path.join(root, "background.js"),
	"utf8",
);

function createBackgroundHarness({
	initialStorage = {},
	fetchImpl,
	existingAlarm = null,
} = {}) {
	const storage = { ...initialStorage };
	let alarm = existingAlarm;
	const calls = {
		fetch: 0,
		alarmsCreated: [],
		alarmsCleared: [],
		sentMessages: [],
	};
	const listeners = {
		installed: [],
		startup: [],
		alarm: [],
		storageChanged: [],
		message: [],
	};
	const local = {
		async get(keys) {
			if (keys == null) return { ...storage };
			if (Array.isArray(keys)) {
				return Object.fromEntries(keys.map((key) => [key, storage[key]]));
			}
			if (typeof keys === "string") return { [keys]: storage[keys] };
			return {
				...keys,
				...Object.fromEntries(
					Object.keys(keys)
						.filter((key) => key in storage)
						.map((key) => [key, storage[key]]),
				),
			};
		},
		async set(values) {
			Object.assign(storage, values);
		},
	};
	const browser = {
		storage: {
			local,
			onChanged: {
				addListener(fn) {
					listeners.storageChanged.push(fn);
				},
			},
		},
		runtime: {
			onInstalled: {
				addListener(fn) {
					listeners.installed.push(fn);
				},
			},
			onStartup: {
				addListener(fn) {
					listeners.startup.push(fn);
				},
			},
			onMessage: {
				addListener(fn) {
					listeners.message.push(fn);
				},
			},
		},
		alarms: {
			create(name, options) {
				calls.alarmsCreated.push({ name, options });
				alarm = { name, ...options };
			},
			async clear(name) {
				calls.alarmsCleared.push(name);
				alarm = null;
				return true;
			},
			async get(name) {
				return alarm?.name === name ? alarm : undefined;
			},
			onAlarm: {
				addListener(fn) {
					listeners.alarm.push(fn);
				},
			},
		},
		tabs: {
			async sendMessage(tabId, message) {
				calls.sentMessages.push({ tabId, message });
			},
		},
	};
	const context = vm.createContext({
		browser,
		console: { error() {}, warn() {}, log() {} },
		AbortController,
		URL,
		Date,
		setTimeout,
		clearTimeout,
		fetch: async (...args) => {
			calls.fetch += 1;
			if (!fetchImpl) throw new Error("Unexpected fetch");
			return fetchImpl(...args);
		},
	});
	context.importScripts = (...files) => {
		for (const file of files) {
			vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, {
				filename: file,
			});
		}
	};
	vm.runInContext(backgroundSource, context, { filename: "background.js" });

	return {
		context,
		storage,
		calls,
		listeners,
		async ready() {
			// Let background.js's fire-and-forget startup initialization settle.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
		async sync(options = {}) {
			return vm.runInContext(
				`syncBrandWhitelist(${JSON.stringify(options)})`,
				context,
			);
		},
		async send(message) {
			const listener = listeners.message[0];
			assert.ok(listener, "background message listener registered");
			return new Promise((resolve, reject) => {
				const keepAlive = listener(message, {}, (response) =>
					resolve(response),
				);
				if (keepAlive !== true)
					reject(new Error("Expected async message response"));
			});
		},
	};
}

function successfulResponse(text = "Acme\nGlobex\nInitech\nUmbrella\n") {
	return {
		ok: true,
		status: 200,
		headers: {
			get() {
				return String(Buffer.byteLength(text));
			},
		},
		async text() {
			return text;
		},
	};
}

test("background initializes fallback while disabled and does not fetch", async () => {
	const harness = createBackgroundHarness();
	await harness.ready();
	assert.ok(
		harness.storage.brandWhitelist.length > 0,
		"bundled whitelist is stored",
	);
	assert.equal(harness.storage.brandWhitelistSource, "bundled");
	assert.equal(harness.calls.fetch, 0);
	assert.deepEqual(harness.calls.alarmsCleared, [
		"prime-rank-filter-refresh-brand-whitelist",
	]);
	const status = await harness.send({
		type: "prime-rank-filter:get-whitelist-status",
	});
	assert.equal(status.source, "bundled");
	assert.equal(status.count, harness.storage.brandWhitelist.length);
});

test("enabling whitelist schedules a daily refresh and starts a sync; disabling clears it", async () => {
	const harness = createBackgroundHarness({
		fetchImpl: async () => successfulResponse(),
	});
	await harness.ready();
	const changeListener = harness.listeners.storageChanged[0];
	harness.storage.brandWhitelistFetchedAt = 1;
	harness.storage.useBrandWhitelist = true;
	changeListener(
		{ useBrandWhitelist: { oldValue: false, newValue: true } },
		"local",
	);
	await harness.ready();
	assert.equal(harness.calls.alarmsCreated.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.alarmsCreated[0])), {
		name: "prime-rank-filter-refresh-brand-whitelist",
		options: { delayInMinutes: 1440, periodInMinutes: 1440 },
	});
	assert.equal(harness.calls.fetch, 1);

	harness.storage.useBrandWhitelist = false;
	changeListener(
		{ useBrandWhitelist: { oldValue: true, newValue: false } },
		"local",
	);
	await harness.ready();
	assert.equal(
		harness.calls.alarmsCleared.at(-1),
		"prime-rank-filter-refresh-brand-whitelist",
	);
});

test("concurrent refresh requests share one remote request", async () => {
	let releaseFetch;
	const fetchGate = new Promise((resolve) => {
		releaseFetch = resolve;
	});
	const harness = createBackgroundHarness({
		fetchImpl: async () => {
			await fetchGate;
			return successfulResponse();
		},
	});
	await harness.ready();
	const first = harness.sync({ force: true });
	const second = harness.sync({ force: true });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.calls.fetch, 1);
	releaseFetch();
	const [firstStatus, secondStatus] = await Promise.all([first, second]);
	assert.deepEqual(firstStatus, secondStatus);
	assert.equal(firstStatus.source, "remote");
	assert.deepEqual(Array.from(harness.storage.brandWhitelist), [
		"Acme",
		"Globex",
		"Initech",
		"Umbrella",
	]);
});

test("failed refresh preserves a stored whitelist and records failure status", async () => {
	const harness = createBackgroundHarness({
		initialStorage: {
			brandWhitelist: ["Existing Brand"],
			brandWhitelistFetchedAt: Date.now(),
			brandWhitelistSource: "remote",
		},
		fetchImpl: async () => {
			throw new Error("offline");
		},
	});
	await harness.ready();
	const status = await harness.sync({ force: true });
	assert.deepEqual(harness.storage.brandWhitelist, ["Existing Brand"]);
	assert.equal(status.source, "remote");
	assert.equal(status.syncStatus, "error");
	assert.equal(status.lastError, "offline");
	assert.ok(status.lastAttemptAt > 0);
});

test("failed first refresh keeps the bundled fallback available", async () => {
	const harness = createBackgroundHarness({
		fetchImpl: async () => {
			throw new Error("offline");
		},
	});
	await harness.ready();
	const result = await harness.sync({ force: true });
	assert.ok(harness.storage.brandWhitelist.length > 0);
	assert.equal(result.source, "bundled");
	assert.equal(result.syncStatus, "error");
	assert.equal(result.lastError, "offline");
});

test("an alarm refreshes the whitelist even when storage is enabled", async () => {
	const harness = createBackgroundHarness({
		initialStorage: {
			useBrandWhitelist: true,
			brandWhitelist: ["Old Brand"],
			brandWhitelistFetchedAt: Date.now(),
		},
		fetchImpl: async () => successfulResponse(),
	});
	await harness.ready();
	const alarmListener = harness.listeners.alarm[0];
	alarmListener({ name: "unrelated-alarm" });
	await harness.ready();
	assert.equal(harness.calls.fetch, 0);
	alarmListener({ name: "prime-rank-filter-refresh-brand-whitelist" });
	await harness.ready();
	assert.equal(harness.calls.fetch, 1);
	assert.equal(harness.storage.brandWhitelistSource, "remote");
});

test("worker startup preserves an existing daily alarm", async () => {
	const harness = createBackgroundHarness({
		initialStorage: {
			useBrandWhitelist: true,
			brandWhitelist: ["Existing Brand"],
			brandWhitelistFetchedAt: Date.now(),
		},
		existingAlarm: {
			name: "prime-rank-filter-refresh-brand-whitelist",
			scheduledTime: Date.now() + 60_000,
		},
	});
	await harness.ready();
	assert.equal(harness.calls.alarmsCreated.length, 0);
	assert.deepEqual(harness.calls.alarmsCleared, []);
});

test("startup recovery leaves an in-process refresh marked as syncing", async () => {
	let releaseFetch;
	const fetchGate = new Promise((resolve) => {
		releaseFetch = resolve;
	});
	const harness = createBackgroundHarness({
		initialStorage: {
			useBrandWhitelist: true,
			brandWhitelist: ["Existing Brand"],
			brandWhitelistFetchedAt: 1,
		},
		fetchImpl: async () => {
			await fetchGate;
			return successfulResponse();
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.storage.brandWhitelistSyncStatus, "syncing");
	harness.listeners.startup[0]();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.storage.brandWhitelistSyncStatus, "syncing");
	releaseFetch();
	await harness.ready();
	assert.equal(harness.storage.brandWhitelistSyncStatus, "idle");
});
