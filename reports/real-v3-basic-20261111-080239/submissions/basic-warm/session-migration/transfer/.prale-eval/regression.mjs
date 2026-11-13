#!/usr/bin/env node
/**
 * Regression for session-migration/transfer.
 *
 * Fault: `migrateSessionsFromAgentRoot()` in packages/coding-agent/src/migrations.ts
 * encoded the session cwd with `replace(/[/:]/g, "-")`, i.e. it never turned
 * Windows backslashes into "-". Legacy session files whose header cwd was a
 * drive-letter (`C:\Users\dev\app`) or UNC (`\\server\share\app`) path were
 * therefore moved into a directory whose name still contained backslashes
 * (and, for drive letters, an unescaped colon), so the migration dropped them
 * somewhere the session manager never looks again.
 *
 * Required encoding (mirrors core/session-manager.ts getDefaultSessionDirPath):
 *   remove one leading "/" or "\", then replace every "/", "\" and ":" with "-",
 *   wrapped in "--...--".
 *
 * The test loads the real production module through the read-only
 * `.prale-eval/subject.mjs` harness, faking only the boundary (the agent/config
 * directory). The filesystem is real (a scratch dir inside the workspace) so
 * byte preservation and rename semantics are genuinely exercised.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "..");
const MIGRATIONS_MODULE = "packages/coding-agent/src/migrations.ts";

const scratch = path.join(here, ".tmp-regression");
const agentDir = path.join(scratch, "agent");
const sessionsDir = path.join(agentDir, "sessions");

/** header cwd -> expected session directory name. */
const MIGRATED = [
	// Windows drive-letter path with backslashes: one leading separator removal is a
	// no-op, then every "\" and ":" becomes "-".
	{ file: "windows-drive-backslash.jsonl", cwd: "C:\\Users\\dev\\work\\app", dirName: "--C--Users-dev-work-app--" },
	// Same drive-letter path written with forward slashes.
	{ file: "windows-drive-forward.jsonl", cwd: "C:/Users/dev/other/app", dirName: "--C--Users-dev-other-app--" },
	// UNC path: exactly one leading "\" is dropped, the rest of the separators become "-".
	{ file: "windows-unc.jsonl", cwd: "\\\\fileserver\\team\\app", dirName: "---fileserver-team-app--" },
	// POSIX path keeps working (leading "/" dropped).
	{ file: "posix.jsonl", cwd: "/home/dev/work/app", dirName: "--home-dev-work-app--" },
];

const UNTOUCHED = {
	"invalid-type.jsonl": { type: "message", cwd: "/tmp/should-not-move" },
	"no-cwd.jsonl": { type: "session", version: 3, id: "sess-nocwd" },
	"malformed.jsonl": "{ this is not json",
	"empty-first-line.jsonl": "\n\n",
	"notes.txt": "not a session file",
};

const COLLISION = {
	file: "collision.jsonl",
	cwd: "/home/dev/collision",
	dirName: "--home-dev-collision--",
	existingBytes: Buffer.from('{"type":"session","id":"already-there","cwd":"/home/dev/collision"}\n', "utf8"),
};

function sessionBytes(cwd) {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "sess-1234",
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	});
	// Body deliberately contains multi-byte UTF-8, CRLF and a NUL-ish tail so a
	// lossy re-encode of the file during the move would be caught.
	const body = JSON.stringify({
		type: "message",
		id: "msg-1234",
		parentId: null,
		timestamp: "2025-01-01T00:00:01.000Z",
		message: { role: "user", content: "héllo 🌍 windows\r\npath", timestamp: 1 },
	});
	return Buffer.from(`${header}\n${body}\n\u0000tail-bytes`, "utf8");
}

function listFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push({ rel: entry.name + "/", dir: true });
		else out.push({ rel: entry.name, dir: false, bytes: readFileSync(full) });
	}
	out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return out;
}

function snapshot() {
	return listFiles(sessionsDir)
		.map((entry) =>
			entry.dir ? `dir:${entry.rel}\n${listFiles(path.join(sessionsDir, entry.rel)).map((f) => `  ${f.rel}:${f.bytes.toString("base64")}`).join("\n")}` : `file:${entry.rel}:${entry.bytes.toString("base64")}`,
		)
		.join("\n---\n");
}

const original = new Map();

async function main() {
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });

	// --- arrange: legacy sessions dumped directly into the agent root ---------
	for (const scenario of MIGRATED) {
		const bytes = sessionBytes(scenario.cwd);
		original.set(scenario.file, bytes);
		writeFileSync(path.join(agentDir, scenario.file), bytes);
	}
	for (const [name, header] of Object.entries(UNTOUCHED)) {
		const bytes =
			typeof header === "string" ? Buffer.from(header, "utf8") : Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
		original.set(name, bytes);
		writeFileSync(path.join(agentDir, name), bytes);
	}
	const collisionSource = sessionBytes(COLLISION.cwd);
	original.set(COLLISION.file, collisionSource);
	writeFileSync(path.join(agentDir, COLLISION.file), collisionSource);
	mkdirSync(path.join(sessionsDir, COLLISION.dirName), { recursive: true });
	writeFileSync(path.join(sessionsDir, COLLISION.dirName, COLLISION.file), COLLISION.existingBytes);

	// --- act: run the real production migration -------------------------------
	const migrations = await loadModule(workspaceRoot, MIGRATIONS_MODULE, {
		default: { green: String, yellow: String, dim: String, red: String },
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => agentDir,
		getBinDir: () => path.join(agentDir, "bin"),
		migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
		stripBom: (value) => value,
	});
	assert.equal(
		typeof migrations.migrateSessionsFromAgentRoot,
		"function",
		"production module must export migrateSessionsFromAgentRoot()",
	);

	migrations.migrateSessionsFromAgentRoot();

	// --- assert: Windows/UNC/POSIX cwds encode exactly like the session manager
	for (const scenario of MIGRATED) {
		const expectedDir = path.join(sessionsDir, scenario.dirName);
		const expectedFile = path.join(expectedDir, scenario.file);
		const label = JSON.stringify(scenario.cwd);

		assert.ok(
			existsSync(expectedDir),
			`cwd ${label} must migrate into ${scenario.dirName} (session manager encoding: drop one leading separator, then replace every "/", "\\" and ":" with "-"); found session dirs: ${JSON.stringify(readdirSync(sessionsDir))}`,
		);
		assert.ok(
			existsSync(expectedFile),
			`legacy session ${scenario.file} (cwd ${label}) must end up at sessions/${scenario.dirName}/${scenario.file}`,
		);
		assert.equal(
			existsSync(path.join(agentDir, scenario.file)),
			false,
			`legacy session ${scenario.file} must not be left behind in the agent root`,
		);
		const moved = readFileSync(expectedFile);
		assert.equal(
			moved.equals(original.get(scenario.file)),
			true,
			`session bytes for ${scenario.file} must be preserved byte-for-byte by the migration`,
		);
	}

	// --- assert: no session directory name may keep a colon or backslash ------
	for (const name of readdirSync(sessionsDir)) {
		assert.equal(name.includes("\\"), false, `session directory name ${JSON.stringify(name)} must not contain "\\"`);
		assert.equal(name.includes(":"), false, `session directory name ${JSON.stringify(name)} must not contain ":"`);
	}

	// --- assert: invalid headers / non-jsonl files are ignored ----------------
	for (const [name, bytes] of Object.entries(UNTOUCHED)) {
		const source = path.join(agentDir, name);
		assert.ok(existsSync(source), `ignored file ${name} must stay in the agent root`);
		assert.equal(
			readFileSync(source).equals(original.get(name)),
			true,
			`ignored file ${name} must not be rewritten by the migration`,
		);
	}
	assert.equal(
		existsSync(path.join(sessionsDir, "--tmp-should-not-move--")),
		false,
		"a non-session header must not create a session directory",
	);

	// --- assert: an existing destination is never overwritten -----------------
	assert.ok(existsSync(path.join(agentDir, COLLISION.file)), "collision source must stay when the destination exists");
	assert.equal(
		readFileSync(path.join(agentDir, COLLISION.file)).equals(collisionSource),
		true,
		"collision source bytes must stay untouched when the destination already exists",
	);
	assert.equal(
		readFileSync(path.join(sessionsDir, COLLISION.dirName, COLLISION.file)).equals(COLLISION.existingBytes),
		true,
		"an existing destination session file must never be overwritten by the migration",
	);

	// --- assert: repeated runs are safe (idempotent, no throw) ----------------
	const afterFirstRun = snapshot();
	migrations.migrateSessionsFromAgentRoot();
	assert.equal(snapshot(), afterFirstRun, "repeated migration runs must be idempotent");
	assert.ok(existsSync(path.join(agentDir, COLLISION.file)), "repeated runs must not move the collision source");
}

try {
	await main();
	process.stdout.write("regression: session-migration/transfer encoding, bytes, ignore, no-overwrite, idempotency OK\n");
} finally {
	try {
		rmSync(scratch, { recursive: true, force: true });
	} catch {
		// best effort cleanup of the scratch directory
	}
}
