// PostToolUse(Edit|Write|apply_patch): format only files changed by the tool.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { affectedPaths, parseHookPayload } from "./tool-paths.mjs";

let raw = "";
process.stdin.on("data", (chunk) => {
	raw += chunk;
});

process.stdin.on("end", () => {
	for (const filePath of affectedPaths(parseHookPayload(raw))) {
		const normalized = filePath.replace(/\\/g, "/");
		if (!/\.(js|mjs|json|jsonc|css|html)$/.test(normalized)) continue;
		// Generated snapshot — excluded from Biome formatting in biome.json.
		if (normalized.endsWith("amazon-brand-whitelist.js")) continue;
		// Deleted and moved-from files no longer exist after apply_patch.
		if (!existsSync(filePath)) continue;

		spawnSync("npx", ["biome", "format", "--write", filePath], {
			stdio: "inherit",
			shell: true,
		});
	}
	// Never block the edit on a formatter failure.
	process.exit(0);
});
