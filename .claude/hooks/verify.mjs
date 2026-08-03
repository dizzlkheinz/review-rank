// Stop: run the test suite before the turn ends. There is no CI in this repo,
// so this is the only automated backstop.
// Exit 2 blocks the stop and hands the failure output back to Claude to fix.
import { spawnSync } from "node:child_process";

let raw = "";
process.stdin.on("data", (chunk) => {
	raw += chunk;
});

process.stdin.on("end", () => {
	let payload = {};
	try {
		payload = JSON.parse(raw || "{}");
	} catch {
		process.exit(0);
	}

	// Guard against a stop -> fix -> stop loop when tests keep failing.
	if (payload.stop_hook_active) process.exit(0);

	// node --test writes results to stdout, but a Stop hook only surfaces stderr
	// back to Claude. Capture and re-emit on stderr so a blocked stop explains itself.
	const result = spawnSync("npm", ["test"], { encoding: "utf8", shell: true });
	if (result.status === 0) process.exit(0);

	const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	process.stderr.write(
		`npm test failed — fix before finishing:\n${out.slice(-4000)}\n`,
	);
	process.exit(2);
});
