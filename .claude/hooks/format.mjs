// PostToolUse(Edit|Write): format only the file that was just edited.
// Claude Code passes tool data as JSON on stdin — there is no
// CLAUDE_TOOL_INPUT_FILE_PATH env var. Reading stdin is the only way to get the path.
import { spawnSync } from "node:child_process";

let raw = "";
process.stdin.on("data", (chunk) => {
	raw += chunk;
});

process.stdin.on("end", () => {
	let filePath = "";
	try {
		filePath = JSON.parse(raw || "{}").tool_input?.file_path ?? "";
	} catch {
		process.exit(0);
	}

	const normalized = filePath.replace(/\\/g, "/");
	if (!normalized) process.exit(0);
	if (!/\.(js|mjs|json|jsonc|css|html)$/.test(normalized)) process.exit(0);
	// Generated snapshot — excluded from Biome formatting in biome.json.
	if (normalized.endsWith("amazon-brand-whitelist.js")) process.exit(0);

	spawnSync("npx", ["biome", "format", "--write", filePath], {
		stdio: "inherit",
		shell: true,
	});
	// Never block the edit on a formatter failure.
	process.exit(0);
});
