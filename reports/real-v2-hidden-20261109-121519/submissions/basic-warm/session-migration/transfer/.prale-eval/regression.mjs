/**
 * Regression for session-migration/transfer.
 *
 * Exercises the real `migrateSessionsFromAgentRoot` from
 * packages/coding-agent/src/migrations.ts through the subject loader, with a
 * caller-owned temporary agentDir and the real fs/path implementations.
 *
 * Fault under test: the migrator encoded cwd with `/[/:]/g`, which left
 * backslashes untouched, so Windows drive-letter and UNC session cwds were
 * migrated into directories literally containing `\` instead of the `-`
 * encoding used by session-manager.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadMigrations } from "./subject.mjs";

const here = import.meta.dirname;
const workspaceRoot = dirname(here);

// Keep scratch data inside the workspace; fall back to the OS temp dir only if
// the submission tree itself is not writable (e.g. a read-only replay mount).
let tempRoot;
try {
	tempRoot = mkdtempSync(join(here, "tmp-session-migration-"));
} catch {
	const { tmpdir } = await import("node:os");
	tempRoot = mkdtempSync(join(tmpdir(), "session-migration-"));
}

/** Build session file content: a session header line plus one payload line. */
function sessionContent(cwd, payload = '{"type":"message","message":{"role":"user","content":"hello"}}') {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id: "fixture-session",
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	})}\n${payload}\n`;
}

function makeAgentDir(name) {
	const dir = join(tempRoot, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function migrate(agentDir) {
	const migrations = await loadMigrations(workspaceRoot, agentDir);
	migrations.migrateSessionsFromAgentRoot();
	return migrations;
}

function expectedSessionDir(agentDir, encoded) {
	return join(agentDir, "sessions", `--${encoded}--`);
}

function assertMigrated({ label, agentDir, cwd, fileName, bytes, encoded }) {
	const sessionDir = expectedSessionDir(agentDir, encoded);
	assert.ok(
		existsSync(sessionDir),
		`${label}: expected session dir ${sessionDir} for cwd ${JSON.stringify(cwd)}; found ${JSON.stringify(
			existsSync(join(agentDir, "sessions")) ? readdirSync(join(agentDir, "sessions")) : [],
		)}`,
	);
	const destination = join(sessionDir, fileName);
	assert.ok(existsSync(destination), `${label}: expected ${fileName} at ${destination}`);
	assert.equal(readFileSync(destination, "utf8"), bytes, `${label}: session bytes must be preserved verbatim`);
	assert.ok(!existsSync(join(agentDir, fileName)), `${label}: source session must no longer remain in agentDir root`);
}

try {
	// --- 1. POSIX absolute path -------------------------------------------------
	{
		const agentDir = makeAgentDir("posix");
		const fileName = "legacy-posix.jsonl";
		const bytes = sessionContent("/home/dev/project", '{"type":"message","message":{"role":"user","content":"héllo ✓"}}');
		writeFileSync(join(agentDir, fileName), bytes);
		await migrate(agentDir);
		assertMigrated({ label: "posix", agentDir, cwd: "/home/dev/project", fileName, bytes, encoded: "home-dev-project" });
	}

	// --- 2. Windows drive letter with backslashes (the original fault) ----------
	{
		const agentDir = makeAgentDir("drive-backslash");
		const fileName = "legacy-drive.jsonl";
		const cwd = "C:\\Users\\dev\\my-project";
		const bytes = sessionContent(cwd);
		writeFileSync(join(agentDir, fileName), bytes);
		await migrate(agentDir);
		assertMigrated({ label: "drive-letter", agentDir, cwd, fileName, bytes, encoded: "C--Users-dev-my-project" });
		const sessionDirs = readdirSync(join(agentDir, "sessions"));
		assert.deepEqual(sessionDirs, ["--C--Users-dev-my-project--"], "drive-letter: exactly one correctly encoded dir");
		assert.ok(
			sessionDirs.every((name) => !name.includes("\\") && !name.includes(":") && !name.includes("/")),
			`drive-letter: encoded dir must not contain path separators or colon, got ${JSON.stringify(sessionDirs)}`,
		);
	}

	// --- 3. Windows drive letter with forward slashes ---------------------------
	{
		const agentDir = makeAgentDir("drive-forward");
		const fileName = "legacy-forward.jsonl";
		const cwd = "D:/work/site";
		const bytes = sessionContent(cwd);
		writeFileSync(join(agentDir, fileName), bytes);
		await migrate(agentDir);
		assertMigrated({ label: "drive-forward", agentDir, cwd, fileName, bytes, encoded: "D--work-site" });
	}

	// --- 4. UNC path: exactly one leading separator is stripped ------------------
	{
		const agentDir = makeAgentDir("unc");
		const fileName = "legacy-unc.jsonl";
		const cwd = "\\\\fileserver\\team\\repo";
		const bytes = sessionContent(cwd);
		writeFileSync(join(agentDir, fileName), bytes);
		await migrate(agentDir);
		assertMigrated({ label: "unc", agentDir, cwd, fileName, bytes, encoded: "-fileserver-team-repo" });
		assert.deepEqual(
			readdirSync(join(agentDir, "sessions")),
			["---fileserver-team-repo--"],
			"unc: one leading backslash removed, remaining separators encoded as '-'",
		);
	}

	// --- 5. Invalid headers are ignored and left untouched -----------------------
	{
		const agentDir = makeAgentDir("invalid");
		const invalidType = join(agentDir, "invalid-type.jsonl");
		const malformed = join(agentDir, "malformed.jsonl");
		const blankHeader = join(agentDir, "blank-header.jsonl");
		const nonSession = join(agentDir, "notes.txt");
		writeFileSync(invalidType, '{"type":"message","cwd":"/home/dev/project"}\n');
		writeFileSync(malformed, '{"type": not-json\n');
		writeFileSync(blankHeader, "\n{\"type\":\"message\"}\n");
		writeFileSync(nonSession, "keep me\n");
		await migrate(agentDir);
		for (const file of [invalidType, malformed, blankHeader, nonSession]) {
			assert.ok(existsSync(file), `invalid: ${file} must remain in place`);
		}
		assert.equal(readFileSync(nonSession, "utf8"), "keep me\n", "invalid: non-session files keep their bytes");
		assert.ok(!existsSync(join(agentDir, "sessions")), "invalid: no session directory is created for ignored headers");
	}

	// --- 6. Never overwrite an existing destination ------------------------------
	{
		const agentDir = makeAgentDir("no-overwrite");
		const fileName = "legacy-collision.jsonl";
		const cwd = "/home/dev/project";
		const destinationDir = expectedSessionDir(agentDir, "home-dev-project");
		mkdirSync(destinationDir, { recursive: true });
		const existing = "already-migrated-bytes\n";
		writeFileSync(join(destinationDir, fileName), existing);
		const sourceBytes = sessionContent(cwd, '{"type":"message","message":{"role":"user","content":"newer"}}');
		writeFileSync(join(agentDir, fileName), sourceBytes);
		await migrate(agentDir);
		assert.equal(
			readFileSync(join(destinationDir, fileName), "utf8"),
			existing,
			"no-overwrite: existing destination bytes must be untouched",
		);
		assert.ok(existsSync(join(agentDir, fileName)), "no-overwrite: source is left in place when destination exists");
		assert.equal(readFileSync(join(agentDir, fileName), "utf8"), sourceBytes, "no-overwrite: source bytes untouched");
	}

	// --- 7. Repeated runs are safe and idempotent --------------------------------
	{
		const agentDir = makeAgentDir("repeat");
		const fileName = "legacy-repeat.jsonl";
		const cwd = "C:\\Users\\dev\\repeat";
		const bytes = sessionContent(cwd);
		writeFileSync(join(agentDir, fileName), bytes);
		await migrate(agentDir);
		const destination = join(expectedSessionDir(agentDir, "C--Users-dev-repeat"), fileName);
		assert.ok(existsSync(destination), "repeat: first run migrates the session");
		await migrate(agentDir);
		await migrate(agentDir);
		assert.ok(existsSync(destination), "repeat: session remains at the encoded destination");
		assert.equal(readFileSync(destination, "utf8"), bytes, "repeat: session bytes unchanged after repeated runs");
		assert.deepEqual(
			readdirSync(join(agentDir, "sessions")),
			["--C--Users-dev-repeat--"],
			"repeat: repeated runs do not create extra encoded directories",
		);
		assert.deepEqual(
			readdirSync(agentDir).filter((name) => name.endsWith(".jsonl")),
			[],
			"repeat: no session files remain at agentDir root",
		);
	}

	// --- 8. Mixed batch: each session lands in its own encoded directory --------
	{
		const agentDir = makeAgentDir("mixed");
		const cases = [
			{ fileName: "posix.jsonl", cwd: "/srv/app", encoded: "srv-app" },
			{ fileName: "drive.jsonl", cwd: "E:\\Data\\App", encoded: "E--Data-App" },
			{ fileName: "unc.jsonl", cwd: "\\\\nas\\share\\app", encoded: "-nas-share-app" },
		];
		for (const item of cases) writeFileSync(join(agentDir, item.fileName), sessionContent(item.cwd));
		await migrate(agentDir);
		for (const item of cases) {
			assertMigrated({ label: `mixed:${item.fileName}`, agentDir, ...item, bytes: sessionContent(item.cwd) });
		}
		assert.equal(readdirSync(join(agentDir, "sessions")).length, 3, "mixed: one directory per distinct cwd");
	}

	console.log("session-migration/transfer regression: all assertions passed");
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
