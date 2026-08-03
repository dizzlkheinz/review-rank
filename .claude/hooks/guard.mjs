// PreToolUse(Edit|Write): block edits to build artifacts and secrets.
// Exit code 2 blocks the tool call and surfaces stderr back to Claude.
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

	if (/\.zip$/i.test(normalized)) {
		console.error(
			"Blocked: ZIP files are build artifacts. Rebuild with the /package skill instead of editing.",
		);
		process.exit(2);
	}

	if (/(^|\/)\.env$/.test(normalized)) {
		console.error(
			"Blocked: .env holds AMO_JWT_ISSUER / AMO_JWT_SECRET. Edit it manually outside Claude.",
		);
		process.exit(2);
	}

	process.exit(0);
});
