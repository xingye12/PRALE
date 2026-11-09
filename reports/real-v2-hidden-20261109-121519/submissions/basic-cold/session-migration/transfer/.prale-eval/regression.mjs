/**
 * Regression for session-migration/transfer.
 *
 * Exercises the real `migrateSessionsFromAgentRoot()` from
 * packages/coding-agent/src/migrations.ts (loaded through the read-only
 * ./subject.mjs helper, which fakes only the external boundaries:
 * getAgentDir/stripBom). Real fs and path are used against temporary
 * agent directories created inside .prale-eval/.
 *
 * Fault covered: the migration encoded the session header cwd with
 * `/[/:]/g` instead of `/[/\\:]/g`, so drive-letter (`C:\a\b`) and UNC
 * (`\\server\share`) cwds kept their backslashes and were moved into a
 * wrong session directory (e.g. `--C-\Users\me\proj--` instead of
 * `--C--Users-me-proj--`).
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { loadMigrations } from "./subject.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]$/, "");
const scratchRoot = path.join(root, ".prale-eval", ".tmp");
mkdirSync(scratchRoot, { recursive: true });

const created = [];
function newAgentDir(label) {
	const dir = mkdtempSync(path.join(scratchRoot, `${label}-`));
	created.push(dir);
	return dir;
}

/** Writes a session file whose first line is a valid header followed by raw bytes. */
function writeSession(agentDir, name, header, tailBytes = Buffer.from('{"type":"message","role":"user"}\n')) {
	const file = path.join(agentDir, name);
	const bytes = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), tailBytes]);
	writeFileSync(file, bytes);
	return bytes;
}

const sessionsDir = (agentDir) => path.join(agentDir, "sessions");
const dirNames = (agentDir) =>
	existsSync(sessionsDir(agentDir)) ? readdirSync(sessionsDir(agentDir)).sort() : [];
const rootJsonl = (agentDir) => readdirSync(agentDir).filter((f) => f.endsWith(".jsonl")).sort();

try {
	// ---------------------------------------------------------------
	// Scenario 1: encoding of POSIX / drive-letter / UNC cwds, session
	// bytes preserved, invalid headers ignored.
	// ---------------------------------------------------------------
	const agentDir = newAgentDir("encoding");
	const posixBytes = writeSession(agentDir, "posix.jsonl", { type: "session", version: 3, cwd: "/home/user/proj" });
	const windowsBytes = writeSession(
		agentDir,
		"windows.jsonl",
		{ type: "session", version: 3, cwd: "C:\\Users\\me\\proj" },
		// Non-UTF-8 payload: proves the migration moves bytes, never re-encodes them.
		Buffer.concat([Buffer.from('{"type":"message","note":"'), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('"}\n')]),
	);
	const uncBytes = writeSession(agentDir, "unc.jsonl", { type: "session", version: 3, cwd: "\\\\server\\share\\proj" });
	const colonBytes = writeSession(agentDir, "colon.jsonl", { type: "session", version: 3, cwd: "/srv/repo:name" });
	// Header line terminated with CRLF must still be understood.
	const crlfBytes = writeSession(
		agentDir,
		"crlf.jsonl",
		{ type: "session", version: 3, cwd: "D:\\work\\app" },
		Buffer.from('{"type":"message"}\r\n'),
	);

	// Files that must be ignored (invalid headers) and left untouched.
	const brokenBytes = Buffer.from("not-json-at-all\n{\"type\":\"message\"}\n");
	writeFileSync(path.join(agentDir, "broken.jsonl"), brokenBytes);
	const noCwdBytes = Buffer.from(`${JSON.stringify({ type: "session", version: 3 })}\n`);
	writeFileSync(path.join(agentDir, "no-cwd.jsonl"), noCwdBytes);
	const otherTypeBytes = Buffer.from(`${JSON.stringify({ type: "message", cwd: "/ignored/dir" })}\n`);
	writeFileSync(path.join(agentDir, "other-type.jsonl"), otherTypeBytes);
	// Not a session file at all: must not be moved either.
	writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"dark"}\n');

	const { migrateSessionsFromAgentRoot } = await loadMigrations(root, agentDir);
	migrateSessionsFromAgentRoot();

	assert.deepEqual(
		dirNames(agentDir),
		[
			"--D--work-app--",
			"--home-user-proj--",
			"--srv-repo-name--",
			"--C--Users-me-proj--",
			"---server-share-proj--",
		].sort(),
		`session directories must be encoded by removing one leading slash/backslash and replacing every slash, backslash and colon with '-'; got ${JSON.stringify(dirNames(agentDir))}`,
	);

	const expectations = [
		["--home-user-proj--", "posix.jsonl", posixBytes],
		["--C--Users-me-proj--", "windows.jsonl", windowsBytes],
		["---server-share-proj--", "unc.jsonl", uncBytes],
		["--srv-repo-name--", "colon.jsonl", colonBytes],
		["--D--work-app--", "crlf.jsonl", crlfBytes],
	];
	for (const [dir, name, bytes] of expectations) {
		const destination = path.join(sessionsDir(agentDir), dir, name);
		assert.ok(existsSync(destination), `expected migrated session at ${dir}/${name}`);
		assert.equal(statSync(destination).isFile(), true, `${dir}/${name} must be a regular file`);
		assert.deepEqual(
			readFileSync(destination),
			bytes,
			`session bytes for ${name} must be preserved exactly (migration must move, not rewrite)`,
		);
		assert.deepEqual(readdirSync(path.join(sessionsDir(agentDir), dir)), [name], `${dir} must contain only ${name}`);
	}

	// Invalid / non-session headers are ignored and stay untouched at the agent root.
	assert.deepEqual(
		rootJsonl(agentDir),
		["broken.jsonl", "no-cwd.jsonl", "other-type.jsonl"],
		`invalid headers must be ignored and left in place; root now has ${JSON.stringify(rootJsonl(agentDir))}`,
	);
	assert.deepEqual(readFileSync(path.join(agentDir, "broken.jsonl")), brokenBytes, "invalid session bytes must be untouched");
	assert.deepEqual(readFileSync(path.join(agentDir, "no-cwd.jsonl")), noCwdBytes, "header without cwd must be untouched");
	assert.deepEqual(
		readFileSync(path.join(agentDir, "other-type.jsonl")),
		otherTypeBytes,
		"non-session header must be untouched",
	);
	assert.deepEqual(readFileSync(path.join(agentDir, "settings.json")), Buffer.from('{"theme":"dark"}\n'));

	// ---------------------------------------------------------------
	// Scenario 2: an existing destination file is never overwritten.
	// ---------------------------------------------------------------
	const existingAgentDir = newAgentDir("existing");
	const existingSourceBytes = writeSession(existingAgentDir, "dup.jsonl", {
		type: "session",
		version: 3,
		cwd: "C:\\Users\\me\\dup",
	});
	const occupiedDir = path.join(sessionsDir(existingAgentDir), "--C--Users-me-dup--");
	mkdirSync(occupiedDir, { recursive: true });
	const occupiedBytes = Buffer.from('{"type":"session","cwd":"C:\\\\Users\\\\me\\\\dup","note":"already-here"}\n');
	writeFileSync(path.join(occupiedDir, "dup.jsonl"), occupiedBytes);

	const existingMigration = await loadMigrations(root, existingAgentDir);
	existingMigration.migrateSessionsFromAgentRoot();

	assert.deepEqual(
		readFileSync(path.join(occupiedDir, "dup.jsonl")),
		occupiedBytes,
		"an existing destination session must never be overwritten",
	);
	assert.deepEqual(
		readFileSync(path.join(existingAgentDir, "dup.jsonl")),
		existingSourceBytes,
		"the source session must be kept intact when the destination already exists",
	);
	assert.deepEqual(
		dirNames(existingAgentDir),
		["--C--Users-me-dup--"],
		`migration must not create a second, wrongly encoded session directory; got ${JSON.stringify(dirNames(existingAgentDir))}`,
	);

	// ---------------------------------------------------------------
	// Scenario 3: repeated runs are safe and idempotent.
	// ---------------------------------------------------------------
	const beforeSecondRun = expectations.map(([dir, name]) => [dir, name, readFileSync(path.join(sessionsDir(agentDir), dir, name))]);
	migrateSessionsFromAgentRoot();
	migrateSessionsFromAgentRoot();

	assert.deepEqual(
		dirNames(agentDir),
		expectations.map(([dir]) => dir).sort(),
		"repeated runs must not create new or duplicate session directories",
	);
	for (const [dir, name, bytes] of beforeSecondRun) {
		assert.deepEqual(readdirSync(path.join(sessionsDir(agentDir), dir)), [name], `${dir} must stay unchanged on repeated runs`);
		assert.deepEqual(readFileSync(path.join(sessionsDir(agentDir), dir, name)), bytes, `${dir}/${name} bytes must stay identical`);
	}
	assert.deepEqual(
		rootJsonl(agentDir),
		["broken.jsonl", "no-cwd.jsonl", "other-type.jsonl"],
		"repeated runs must keep ignoring invalid headers",
	);

	console.log("session-migration/transfer regression: all assertions passed");
} finally {
	for (const dir of created.reverse()) rmSync(dir, { recursive: true, force: true });
	try {
		if (readdirSync(scratchRoot).length === 0) rmSync(scratchRoot, { recursive: true, force: true });
	} catch {
		// scratch cleanup is best effort
	}
}
