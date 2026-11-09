#!/usr/bin/env node
/**
 * Standalone regression for session-migration/transfer.
 *
 * Loads the real packages/coding-agent/src/migrations.ts through the read-only
 * .prale-eval/subject.mjs helper (Node 24 type stripping + VM module, real fs/path,
 * getAgentDir/stripBom supplied by the helper) and drives
 * migrateSessionsFromAgentRoot() against temporary agent directories.
 *
 * Invariants under test (as specified by TASK.md):
 *   1. POSIX, drive-letter and UNC cwd values are encoded by removing one leading
 *      slash/backslash and replacing every slash, backslash and colon with "-".
 *   2. Session file bytes are preserved by the move.
 *   3. Invalid session headers are ignored (files left untouched).
 *   4. An existing destination is never overwritten.
 *   5. Repeated runs are safe (idempotent, no duplicate/renamed output).
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Trailing bytes deliberately include CRLF, a NUL, an invalid UTF-8 byte (0xff)
// and multi-byte characters: a rename must preserve them byte for byte.
const SESSION_TAIL = Buffer.concat([
	Buffer.from('{"type":"message","role":"user","text":"héllo 🌍"}\r\n', "utf8"),
	Buffer.from([0xff, 0x00, 0x0a]),
]);

function header(cwd) {
	return `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd })}\n`;
}

function sessionBytes(cwd) {
	return Buffer.concat([Buffer.from(header(cwd), "utf8"), SESSION_TAIL]);
}

/** Temporary parent directory: inside the workspace when writable, else OS tmp. */
function tempParent() {
	for (const candidate of [
		path.join(root, ".prale-eval", ".tmp"),
		path.join(tmpdir(), "prale-session-migration"),
	]) {
		try {
			mkdirSync(candidate, { recursive: true });
			const probe = mkdtempSync(path.join(candidate, "probe-"));
			rmSync(probe, { recursive: true, force: true });
			return candidate;
		} catch {
			// Try the next candidate location.
		}
	}
	throw new Error("no writable temporary directory available for the regression");
}

const base = tempParent();
let assertions = 0;

function freshAgentDir(label) {
	return mkdtempSync(path.join(base, `${label.replace(/[^a-z0-9-]+/gi, "_")}-`));
}

function listDir(dir) {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

async function migrate(agentDir) {
	const module = await loadMigrations(root, agentDir);
	assert.equal(
		typeof module.migrateSessionsFromAgentRoot,
		"function",
		"migrations.ts must export migrateSessionsFromAgentRoot",
	);
	assertions += 1;
	module.migrateSessionsFromAgentRoot();
}

/** Write one session whose header carries `cwd`, run the migration, verify the move. */
async function expectMigrated({ label, cwd, expectedName, fileName = "session-1.jsonl" }) {
	const agentDir = freshAgentDir(label);
	const sourcePath = path.join(agentDir, fileName);
	const bytes = sessionBytes(cwd);
	writeFileSync(sourcePath, bytes);

	await migrate(agentDir);

	assert.equal(
		existsSync(sourcePath),
		false,
		`${label}: session file must be moved out of the agent root for cwd ${JSON.stringify(cwd)}`,
	);
	assertions += 1;

	const sessionsDir = path.join(agentDir, "sessions");
	const entries = listDir(sessionsDir);
	assert.deepEqual(
		entries,
		[expectedName],
		`${label}: cwd ${JSON.stringify(cwd)} must encode to the single flat directory ${expectedName}, got ${JSON.stringify(entries)}`,
	);
	assertions += 1;

	const destination = path.join(sessionsDir, expectedName, fileName);
	assert.ok(
		existsSync(destination),
		`${label}: migrated session must exist at sessions/${expectedName}/${fileName}`,
	);
	assertions += 1;

	const moved = readFileSync(destination);
	assert.ok(
		moved.equals(bytes),
		`${label}: session bytes must be preserved exactly (expected ${bytes.length} bytes, got ${moved.length})`,
	);
	assertions += 1;
}

async function main() {
	// ---------------------------------------------------------------- encoding
	// POSIX absolute path: one leading slash removed, every slash becomes "-".
	await expectMigrated({
		label: "posix",
		cwd: "/home/user/project",
		expectedName: "--home-user-project--",
	});

	// POSIX path with a colon-free deep hierarchy.
	await expectMigrated({
		label: "posix-deep",
		cwd: "/mnt/data/work/repos/pi",
		expectedName: "--mnt-data-work-repos-pi--",
	});

	// Windows drive-letter path: backslashes and the drive colon all become "-",
	// so the encoded name is flat (no nested directories) under sessions/.
	await expectMigrated({
		label: "drive-letter",
		cwd: "C:\\Users\\dev\\app",
		expectedName: "--C--Users-dev-app--",
	});

	// UNC path: exactly one leading backslash is removed, the rest become "-".
	await expectMigrated({
		label: "unc",
		cwd: "\\\\fileserver\\team share\\proj",
		expectedName: "---fileserver-team share-proj--",
	});

	// Two sessions for the same cwd share one directory and keep their own bytes.
	{
		const agentDir = freshAgentDir("same-cwd");
		const first = sessionBytes("/home/user/project");
		const second = Buffer.concat([
			Buffer.from(header("/home/user/project"), "utf8"),
			Buffer.from('{"type":"message","role":"assistant","text":"second"}\n', "utf8"),
		]);
		writeFileSync(path.join(agentDir, "session-1.jsonl"), first);
		writeFileSync(path.join(agentDir, "session-2.jsonl"), second);

		await migrate(agentDir);

		const sessionsDir = path.join(agentDir, "sessions");
		assert.deepEqual(
			listDir(sessionsDir),
			["--home-user-project--"],
			"same-cwd: both sessions must land in one encoded directory",
		);
		assertions += 1;
		assert.deepEqual(
			listDir(path.join(sessionsDir, "--home-user-project--")),
			["session-1.jsonl", "session-2.jsonl"],
			"same-cwd: both session files must be moved with their names intact",
		);
		assertions += 1;
		assert.ok(
			readFileSync(path.join(sessionsDir, "--home-user-project--", "session-1.jsonl")).equals(first),
			"same-cwd: first session bytes must be preserved",
		);
		assertions += 1;
		assert.ok(
			readFileSync(path.join(sessionsDir, "--home-user-project--", "session-2.jsonl")).equals(second),
			"same-cwd: second session bytes must be preserved",
		);
		assertions += 1;
	}

	// ------------------------------------------------------- invalid headers
	{
		const agentDir = freshAgentDir("invalid-headers");
		const untouched = {
			"empty.jsonl": Buffer.from("", "utf8"),
			"malformed.jsonl": Buffer.from('not-json{"type":"session"\nsecond line\n', "utf8"),
			"wrong-type.jsonl": Buffer.from('{"type":"summary","cwd":"/home/user/project"}\n', "utf8"),
			"missing-cwd.jsonl": Buffer.from('{"type":"session","version":3}\n', "utf8"),
			"null-header.jsonl": Buffer.from("null\n", "utf8"),
			"empty-cwd.jsonl": Buffer.from('{"type":"session","cwd":""}\n', "utf8"),
		};
		for (const [name, bytes] of Object.entries(untouched)) {
			writeFileSync(path.join(agentDir, name), bytes);
		}
		const valid = sessionBytes("/home/user/project");
		writeFileSync(path.join(agentDir, "valid.jsonl"), valid);

		await migrate(agentDir);

		for (const [name, bytes] of Object.entries(untouched)) {
			assert.ok(
				existsSync(path.join(agentDir, name)),
				`invalid-headers: ${name} must be left in the agent root`,
			);
			assertions += 1;
			assert.ok(
				readFileSync(path.join(agentDir, name)).equals(bytes),
				`invalid-headers: ${name} must not be modified`,
			);
			assertions += 1;
		}
		assert.deepEqual(
			listDir(path.join(agentDir, "sessions")),
			["--home-user-project--"],
			"invalid-headers: only the valid session may produce a session directory",
		);
		assertions += 1;
		assert.deepEqual(
			listDir(path.join(agentDir, "sessions", "--home-user-project--")),
			["valid.jsonl"],
			"invalid-headers: only the valid session may be moved",
		);
		assertions += 1;
		assert.ok(
			readFileSync(path.join(agentDir, "sessions", "--home-user-project--", "valid.jsonl")).equals(valid),
			"invalid-headers: valid session bytes must be preserved",
		);
		assertions += 1;
	}

	// --------------------------------------------------- existing destination
	{
		const agentDir = freshAgentDir("no-overwrite");
		const sessionsDir = path.join(agentDir, "sessions", "--home-user-project--");
		mkdirSync(sessionsDir, { recursive: true });
		const sentinel = Buffer.from('{"existing":true,"cwd":"/home/user/project"}\n', "utf8");
		writeFileSync(path.join(sessionsDir, "session-1.jsonl"), sentinel);

		const source = sessionBytes("/home/user/project");
		writeFileSync(path.join(agentDir, "session-1.jsonl"), source);

		await migrate(agentDir);

		assert.ok(
			readFileSync(path.join(sessionsDir, "session-1.jsonl")).equals(sentinel),
			"no-overwrite: an existing destination file must never be overwritten",
		);
		assertions += 1;
		assert.ok(
			existsSync(path.join(agentDir, "session-1.jsonl")),
			"no-overwrite: the source must be left in place when the destination already exists",
		);
		assertions += 1;
		assert.ok(
			readFileSync(path.join(agentDir, "session-1.jsonl")).equals(source),
			"no-overwrite: the un-migrated source bytes must be unchanged",
		);
		assertions += 1;
		assert.deepEqual(
			listDir(sessionsDir),
			["session-1.jsonl"],
			"no-overwrite: no extra files may appear next to the existing destination",
		);
		assertions += 1;
	}

	// ----------------------------------------------------- repeated runs safe
	{
		const agentDir = freshAgentDir("repeated");
		const bytes = sessionBytes("C:\\Users\\dev\\app");
		writeFileSync(path.join(agentDir, "session-1.jsonl"), bytes);

		await migrate(agentDir);
		const destination = path.join(agentDir, "sessions", "--C--Users-dev-app--", "session-1.jsonl");
		assert.ok(existsSync(destination), "repeated: first run must migrate the session");
		assertions += 1;
		const afterFirst = readFileSync(destination);

		await migrate(agentDir);
		await migrate(agentDir);

		assert.deepEqual(
			listDir(agentDir),
			["sessions"],
			"repeated: later runs must not recreate the source file in the agent root",
		);
		assertions += 1;
		assert.deepEqual(
			listDir(path.join(agentDir, "sessions")),
			["--C--Users-dev-app--"],
			"repeated: later runs must not create duplicate session directories",
		);
		assertions += 1;
		assert.deepEqual(
			listDir(path.join(agentDir, "sessions", "--C--Users-dev-app--")),
			["session-1.jsonl"],
			"repeated: later runs must not duplicate or rename the migrated session",
		);
		assertions += 1;
		assert.ok(
			readFileSync(destination).equals(afterFirst),
			"repeated: the migrated session bytes must stay identical across runs",
		);
		assertions += 1;
	}

	return assertions;
}

try {
	const total = await main();
	console.log(`session-migration/transfer regression: ${total} assertions passed`);
} finally {
	rmSync(base, { recursive: true, force: true });
}
