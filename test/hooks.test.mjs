import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { affectedPaths } from "../.claude/hooks/tool-paths.mjs";

test("extracts Claude Edit and Write paths", () => {
	assert.deepEqual(
		affectedPaths({
			tool_name: "Write",
			tool_input: { file_path: "popup.js" },
		}),
		["popup.js"],
	);
});

test("extracts every path from a Codex apply_patch payload", () => {
	const command = `*** Begin Patch
*** Update File: popup.js
*** Move to: src/popup.js
*** Add File: styles/new.css
*** Delete File: old.json
*** End Patch`;

	assert.deepEqual(
		affectedPaths({ tool_name: "apply_patch", tool_input: { command } }),
		["popup.js", "styles/new.css", "old.json", "src/popup.js"],
	);
});

test("extracts snake_case paths from nested MCP arguments", () => {
	assert.deepEqual(
		affectedPaths({
			tool_name: "mcp__filesystem__move_file",
			tool_input: {
				source_path: "old.js",
				destination_path: "new.js",
				options: { output_path: "report.json" },
			},
		}),
		["old.js", "new.js", "report.json"],
	);
});

test("guard blocks protected paths in Codex apply_patch calls", () => {
	const result = spawnSync("node", [".claude/hooks/guard.mjs"], {
		input: JSON.stringify({
			tool_name: "apply_patch",
			tool_input: {
				command: "*** Begin Patch\n*** Update File: .env\n*** End Patch",
			},
		}),
		encoding: "utf8",
	});

	assert.equal(result.status, 2);
	assert.match(result.stderr, /Blocked: \.env/);
});

test("guard allows ordinary Codex apply_patch calls", () => {
	const result = spawnSync("node", [".claude/hooks/guard.mjs"], {
		input: JSON.stringify({
			tool_name: "apply_patch",
			tool_input: {
				command: "*** Begin Patch\n*** Update File: popup.js\n*** End Patch",
			},
		}),
		encoding: "utf8",
	});

	assert.equal(result.status, 0);
});

test("guard blocks protected snake_case paths in Codex MCP calls", () => {
	const result = spawnSync("node", [".claude/hooks/guard.mjs"], {
		input: JSON.stringify({
			tool_name: "mcp__codex_apps__github_update_file",
			tool_input: { path: ".env" },
		}),
		encoding: "utf8",
	});

	assert.equal(result.status, 2);
	assert.match(result.stderr, /Blocked: \.env/);
});
