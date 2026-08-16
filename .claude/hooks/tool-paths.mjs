const PATH_KEYS = new Set([
	"destination_path",
	"file_path",
	"filePath",
	"new_path",
	"output_path",
	"path",
	"source_path",
]);

function addPath(paths, value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (trimmed) paths.add(trimmed);
}

function collectNamedPaths(value, paths) {
	if (!value || typeof value !== "object") return;

	if (Array.isArray(value)) {
		for (const item of value) collectNamedPaths(item, paths);
		return;
	}

	for (const [key, item] of Object.entries(value)) {
		if (PATH_KEYS.has(key)) {
			if (Array.isArray(item)) {
				for (const candidate of item) addPath(paths, candidate);
			} else {
				addPath(paths, item);
			}
		}

		if (item && typeof item === "object") collectNamedPaths(item, paths);
	}
}

function collectApplyPatchPaths(command, paths) {
	if (typeof command !== "string") return;

	const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
	for (const match of command.matchAll(header)) addPath(paths, match[1]);

	const move = /^\*\*\* Move to: (.+)$/gm;
	for (const match of command.matchAll(move)) addPath(paths, match[1]);
}

export function parseHookPayload(raw) {
	try {
		return JSON.parse(raw || "{}");
	} catch {
		return {};
	}
}

export function affectedPaths(payload) {
	const paths = new Set();
	const input = payload?.tool_input;
	collectNamedPaths(input, paths);

	if (payload?.tool_name === "apply_patch" || payload?.tool_name === "Patch") {
		collectApplyPatchPaths(input?.command, paths);
	}

	return [...paths];
}
