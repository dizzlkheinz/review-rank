// PreToolUse(Edit|Write|apply_patch): block edits to build artifacts and secrets.
// Exit code 2 blocks the tool call and surfaces stderr in Claude and Codex.
import { affectedPaths, parseHookPayload } from "./tool-paths.mjs";

let raw = "";
process.stdin.on("data", (chunk) => {
	raw += chunk;
});

process.stdin.on("end", () => {
	for (const filePath of affectedPaths(parseHookPayload(raw))) {
		const normalized = filePath.replace(/\\/g, "/");

		if (/\.zip$/i.test(normalized)) {
			console.error(
				"Blocked: ZIP files are build artifacts. Rebuild with the /package skill instead of editing.",
			);
			process.exit(2);
		}

		if (/(^|\/)\.env$/.test(normalized)) {
			console.error(
				"Blocked: .env holds AMO_JWT_ISSUER / AMO_JWT_SECRET. Edit it manually outside the coding agent.",
			);
			process.exit(2);
		}
	}

	process.exit(0);
});
