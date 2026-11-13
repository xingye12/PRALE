/**
 * Regression for session-migration/transfer.
 *
 * Exercises the real `migrateSessionsFromAgentRoot` from
 * packages/coding-agent/src/migrations.ts (loaded by ./subject.mjs, which only
 * fakes the external boundaries `getAgentDir` and `stripBom`).
 *
 * Fault fixed: the cwd encoding only rewrote `/` and `:`, so Windows
 * drive-letter and UNC session paths (`C:\Users\me`, `\\server\share\dir`)
 * were migrated into directory names that still contained backslashes instead
 * of the canonical `--C--Users-me--` / `---server-share-dir--` form used by
 * session-manager.ts.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** Prefer a scratch dir next to this script; fall back to the OS temp dir if
 * the checkout is read-only. */
function resolveScratch() {
	const preferred = path.join(here, ".tmp-regression");
	try {
		mkdirSync(preferred, { recursive: true });
		return preferred;
	} catch {
		return mkdtempSync(path.join(os.tmpdir(), "prale-regression-"));
	}
}

const scratch = resolveScratch();

/**
 * Canonical encoding: drop one leading slash/backslash, then replace every
 * slash, backslash and colon with '-'.
 */
function encodeCwd(cwd) {
	const trimmed = cwd.replace(/^[/\\]/, "");
	return `--${trimmed.replace(/[/\\:]/g, "-")}--`;
}

/** Session file bytes: a header line plus a message line. */
function sessionBytes(cwd) {
	const header = JSON.stringify({ type: "session", version: 3, id: `id-${cwd.length}`, timestamp: "2025-01-01T00:00:00.000Z", cwd });
	const message = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } });
	return `${header}\n${message}\n`;
}

function freshAgentDir(name) {
	const dir = path.join(scratch, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function listSessionsDirs(agentDir) {
	const sessionsDir = path.join(agentDir, "sessions");
	if (!existsSync(sessionsDir)) return [];
	return readdirSync(sessionsDir).sort();
}

async function migrate(agentDir) {
	const migrations = await loadMigrations(root, agentDir);
	assert.equal(typeof migrations.migrateSessionsFromAgentRoot, "function", "subject must export migrateSessionsFromAgentRoot");
	migrations.migrateSessionsFromAgentRoot();
}

/** POSIX, drive-letter and UNC cwds must all land in the canonical directory. */
const encodingCases = [
	{ label: "posix", cwd: "/home/alice/project", fileName: "session-posix.jsonl" },
	{ label: "drive-letter", cwd: "C:\\Users\\alice\\project", fileName: "session-drive.jsonl" },
	{ label: "drive-letter-forward", cwd: "D:/Work/Deep/Nested", fileName: "session-drive-fwd.jsonl" },
	{ label: "unc", cwd: "\\\\fileserver\\team\\pi", fileName: "session-unc.jsonl" },
];

async function main() {
	rmSync(scratch, { recursive: true, force: true });

	// 1. Path encoding for every path flavour.
	for (const { label, cwd, fileName } of encodingCases) {
		const agentDir = freshAgentDir(`encoding-${label}`);
		const original = sessionBytes(cwd);
		const sourcePath = path.join(agentDir, fileName);
		writeFileSync(sourcePath, original);

		await migrate(agentDir);

		const expectedDirName = encodeCwd(cwd);
		const expectedPath = path.join(agentDir, "sessions", expectedDirName, fileName);

		assert.ok(
			existsSync(expectedPath),
			`${label} session must migrate to sessions/${expectedDirName}/${fileName} (cwd ${JSON.stringify(cwd)})`,
		);
		assert.equal(readFileSync(expectedPath, "utf8"), original, `${label} session bytes must be preserved exactly`);
		assert.equal(existsSync(sourcePath), false, `${label} source file must no longer remain in the agent dir`);
		assert.deepEqual(
			listSessionsDirs(agentDir),
			[expectedDirName],
			`${label} migration must create exactly the canonical session directory, got ${JSON.stringify(listSessionsDirs(agentDir))}`,
		);
		for (const entry of listSessionsDirs(agentDir)) {
			assert.equal(
				/[:\\]/.test(entry),
				false,
				`${label} encoded session directory must not contain ':' or '\\': ${JSON.stringify(entry)}`,
			);
		}
	}

	// 2. Invalid or non-session headers are ignored and left untouched.
	{
		const agentDir = freshAgentDir("invalid-headers");
		const fixtures = {
			"broken.jsonl": "this is not json at all\n",
			"wrong-type.jsonl": `${JSON.stringify({ type: "message", cwd: "/home/alice/project" })}\n`,
			"no-cwd.jsonl": `${JSON.stringify({ type: "session" })}\n`,
			"empty.jsonl": "",
			"null.jsonl": "null\n",
		};
		for (const [name, content] of Object.entries(fixtures)) writeFileSync(path.join(agentDir, name), content);

		await migrate(agentDir);

		for (const [name, content] of Object.entries(fixtures)) {
			const filePath = path.join(agentDir, name);
			assert.ok(existsSync(filePath), `invalid header file ${name} must stay in the agent dir`);
			assert.equal(readFileSync(filePath, "utf8"), content, `invalid header file ${name} must not be modified`);
		}
		assert.deepEqual(listSessionsDirs(agentDir), [], "no session directory may be created for invalid headers");
	}

	// 3. An existing destination file is never overwritten (source is kept).
	{
		const agentDir = freshAgentDir("no-overwrite");
		const cwd = "/home/alice/project";
		const fileName = "session-existing.jsonl";
		const sourcePath = path.join(agentDir, fileName);
		const sourceBytes = sessionBytes(cwd);
		writeFileSync(sourcePath, sourceBytes);

		const destDir = path.join(agentDir, "sessions", encodeCwd(cwd));
		mkdirSync(destDir, { recursive: true });
		const destPath = path.join(destDir, fileName);
		const destBytes = `${JSON.stringify({ type: "session", cwd })}  // pre-existing destination\n`;
		writeFileSync(destPath, destBytes);

		await migrate(agentDir);

		assert.equal(readFileSync(destPath, "utf8"), destBytes, "existing destination session must not be overwritten");
		assert.ok(existsSync(sourcePath), "source session must be left in place when the destination already exists");
		assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes, "unmigrated source session must keep its bytes");
	}

	// 4. Repeated runs are safe: no throw, no duplicated directories or files.
	{
		const agentDir = freshAgentDir("repeat");
		const cwd = "C:\\Users\\alice\\project";
		const original = sessionBytes(cwd);
		writeFileSync(path.join(agentDir, "session-repeat.jsonl"), original);

		await migrate(agentDir);
		await migrate(agentDir);
		await migrate(agentDir);

		const expectedDirName = encodeCwd(cwd);
		const destDir = path.join(agentDir, "sessions", expectedDirName);
		assert.deepEqual(listSessionsDirs(agentDir), [expectedDirName], "repeated runs must not create extra session directories");
		assert.deepEqual(readdirSync(destDir), ["session-repeat.jsonl"], "repeated runs must not duplicate the migrated session");
		assert.equal(readFileSync(path.join(destDir, "session-repeat.jsonl"), "utf8"), original, "repeated runs must keep session bytes");
	}

	rmSync(scratch, { recursive: true, force: true });
	console.log("regression: session migration encoding, header validation, overwrite and idempotency checks passed");
}

try {
	await main();
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
