/**
 * Cross-module regression for advanced/session-integrity/correction.
 *
 * Loads the submitted production modules through the read-only subject helper
 * (real migrations -> real text/path helpers -> real session reader/writer) and
 * asserts the observable data-safety contract:
 *
 *   1. Existing destination bytes always win during session-directory migration;
 *      both sides of a collision survive and later migrations still run.
 *   2. The session reader rejects a header that lacks a string id *before* any
 *      missing-final-newline repair, leaving the invalid file byte-identical.
 *   3. Valid headers are still accepted and a valid unterminated final record is
 *      repaired exactly once.
 *
 * Assertions are uncaught `node:assert/strict`; no real time, randomness or
 * external services are used as correctness evidence. Scratch inputs live under
 * `.prale-eval/` and are removed when the script exits.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "..");
const scratchRoot = path.join(here, ".tmp-session-integrity");

const tests = [];
function test(name, run) {
	tests.push({ name, run });
}

function readBytes(file) {
	return readFileSync(file, "utf8");
}

function writeBytes(file, content) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function sessionHeader(cwd, id, extra = {}) {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00Z",
		cwd,
		...extra,
	})}\n`;
}

function messageEntry(id) {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: `body-${id}`, timestamp: 1 },
	})}\n`;
}

/** Same encoding as migrations.ts / session-manager.ts for a cwd. */
function encodedSessionDir(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function freshAgentDir(name) {
	const agentDir = path.join(scratchRoot, name, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

test("migration preserves existing destination bytes and keeps the colliding source", async () => {
	const agentDir = freshAgentDir("collision");
	// Sorted readdir order: collision.jsonl runs first, migrate-me.jsonl second.
	const collidedCwd = "/projects/alpha";
	const otherCwd = "/projects/beta";
	const sourceFile = path.join(agentDir, "collision.jsonl");
	const sourceBytes = `${sessionHeader(collidedCwd, "incoming-session")}${messageEntry("incoming-1")}`;
	const destinationFile = path.join(agentDir, "sessions", encodedSessionDir(collidedCwd), "collision.jsonl");
	const destinationBytes = `${sessionHeader(collidedCwd, "existing-session")}${messageEntry("existing-1")}`;
	writeBytes(sourceFile, sourceBytes);
	writeBytes(destinationFile, destinationBytes);

	const { migration } = await createSessionPipeline(workspaceRoot, agentDir);
	migration.migrateSessionsFromAgentRoot();

	// Both sides of the collision must survive untouched.
	assert.equal(existsSync(sourceFile), true, "collision must not delete the source session");
	assert.equal(readBytes(sourceFile), sourceBytes, "collision must not rewrite the source session");
	assert.equal(readBytes(destinationFile), destinationBytes, "existing destination bytes always win");
});

test("migration continues with non-colliding sessions after a collision", async () => {
	const agentDir = freshAgentDir("continue");
	const collidedCwd = "/projects/gamma";
	const otherCwd = "/projects/delta";
	const sourceFile = path.join(agentDir, "collision.jsonl");
	const destinationFile = path.join(agentDir, "sessions", encodedSessionDir(collidedCwd), "collision.jsonl");
	writeBytes(sourceFile, sessionHeader(collidedCwd, "collision-source"));
	writeBytes(destinationFile, sessionHeader(collidedCwd, "collision-destination"));

	const otherSourceFile = path.join(agentDir, "migrate-me.jsonl");
	const otherBytes = `${sessionHeader(otherCwd, "migrated-session")}${messageEntry("migrated-1")}`;
	writeBytes(otherSourceFile, otherBytes);

	const { migration } = await createSessionPipeline(workspaceRoot, agentDir);
	migration.migrateSessionsFromAgentRoot();

	const otherDestination = path.join(agentDir, "sessions", encodedSessionDir(otherCwd), "migrate-me.jsonl");
	assert.equal(existsSync(otherSourceFile), false, "non-colliding session must be migrated out of the agent root");
	assert.equal(readBytes(otherDestination), otherBytes, "migrated session bytes must be preserved exactly");
	assert.equal(existsSync(sourceFile), true, "collision must not abort later migrations or delete sources");
});

test("reader rejects an invalid header without repairing its file", async () => {
	const agentDir = freshAgentDir("invalid-headers");
	const { session } = await createSessionPipeline(workspaceRoot, agentDir);
	const cases = [
		{
			name: "session header without an id",
			content: `${JSON.stringify({
				type: "session",
				version: 3,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			})}`,
		},
		{
			name: "session header with a numeric id",
			content: `${JSON.stringify({
				type: "session",
				version: 3,
				id: 7,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			})}`,
		},
		{
			name: "non-session first record with a string id",
			content: `${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
			})}`,
		},
	];

	for (const { name, content } of cases) {
		const file = path.join(agentDir, "sessions", `${name.replace(/[^a-z0-9]+/gi, "-")}.jsonl`);
		writeBytes(file, content);
		const entries = session.loadEntriesFromFile(file);
		assert.equal(entries.length, 0, `loadEntriesFromFile must reject ${name}`);
		assert.equal(readBytes(file), content, `rejecting ${name} must not rewrite the file`);

		// A terminated variant must be rejected too, with identical bytes.
		const terminated = path.join(agentDir, "sessions", `terminated-${name.replace(/[^a-z0-9]+/gi, "-")}.jsonl`);
		writeBytes(terminated, `${content}\n`);
		const terminatedEntries = session.loadEntriesFromFile(terminated);
		assert.equal(terminatedEntries.length, 0, `loadEntriesFromFile must reject terminated ${name}`);
		assert.equal(readBytes(terminated), `${content}\n`, `rejecting terminated ${name} must not rewrite the file`);
	}
});

test("reader accepts a valid header and repairs a valid unterminated final record once", async () => {
	const agentDir = freshAgentDir("valid-repair");
	const { session } = await createSessionPipeline(workspaceRoot, agentDir);
	const file = path.join(agentDir, "sessions", "valid-unterminated.jsonl");
	const content = `${sessionHeader("/tmp", "abc")}${messageEntry("m1").trimEnd()}`;
	writeBytes(file, content);

	const entries = session.loadEntriesFromFile(file);
	assert.equal(entries.length, 2, "valid header plus unterminated record must both load");
	assert.equal(entries[0].type, "session");
	assert.equal(entries[0].id, "abc");
	assert.equal(entries[1].id, "m1");
	assert.equal(readBytes(file), `${content}\n`, "the missing final newline must be repaired exactly once");

	// Reading again must neither duplicate nor add another newline.
	const again = session.loadEntriesFromFile(file);
	assert.equal(again.length, 2, "second read must return the same entries");
	assert.equal(readBytes(file), `${content}\n`, "repair must be idempotent");
});

test("reader leaves a terminated valid session byte-identical", async () => {
	const agentDir = freshAgentDir("valid-terminated");
	const { session } = await createSessionPipeline(workspaceRoot, agentDir);
	const file = path.join(agentDir, "sessions", "valid-terminated.jsonl");
	const content = `${sessionHeader("/tmp", "abc")}${messageEntry("m1")}`;
	writeBytes(file, content);

	assert.equal(session.loadEntriesFromFile(file).length, 2);
	assert.equal(readBytes(file), content, "a terminated file needs no repair");
});

test("SessionManager.open refuses an invalid header file without rewriting it", async () => {
	const agentDir = freshAgentDir("open-invalid");
	const { session } = await createSessionPipeline(workspaceRoot, agentDir);
	const dir = path.join(agentDir, "sessions");
	const file = path.join(dir, "invalid.jsonl");
	const content = `${JSON.stringify({
		type: "session",
		version: 3,
		timestamp: "2025-01-01T00:00:00Z",
		cwd: "/tmp",
	})}`;
	writeBytes(file, content);

	assert.throws(
		() => session.SessionManager.open(file, dir),
		/not a valid .* session/,
		"opening a header without a string id must fail",
	);
	assert.equal(readBytes(file), content, "a rejected header file must not be rewritten");
});

test("SessionManager.open accepts a valid session and repairs its final record", async () => {
	const agentDir = freshAgentDir("open-valid");
	const { session } = await createSessionPipeline(workspaceRoot, agentDir);
	const dir = path.join(agentDir, "sessions");
	const file = path.join(dir, "valid.jsonl");
	const content = `${sessionHeader(dir, "abc")}${messageEntry("m1").trimEnd()}`;
	writeBytes(file, content);

	const manager = session.SessionManager.open(file, dir);
	assert.equal(manager.getSessionId(), "abc", "valid header must be accepted");
	assert.equal(manager.getEntries().length, 1, "the unterminated final record must load");
	assert.equal(readBytes(file), `${content}\n`, "the valid file must be repaired once");
});

test("async session listing reports progress in deterministic order and keeps valid sessions", async () => {
	const agentDir = freshAgentDir("list");
	const { session } = await createSessionPipeline(workspaceRoot, agentDir);
	const dir = path.join(agentDir, "sessions");
	writeBytes(path.join(dir, "valid.jsonl"), sessionHeader(dir, "abc"));
	writeBytes(path.join(dir, "not-a-session.jsonl"), `${JSON.stringify({ type: "message", id: "m1" })}\n`);

	const progress = [];
	const sessions = await session.SessionManager.listAll(dir, (loaded, total, partial) => {
		// Copy out of the module realm so comparisons stay realm-independent.
		progress.push({ loaded, total, partial: partial ? Array.from(partial, (info) => info.id) : null });
	});

	assert.deepEqual(
		Array.from(sessions, (info) => info.id),
		["abc"],
		"listing must surface the valid session and drop the non-session file",
	);
	assert.equal(progress.length, 2, "progress must publish after the first file and after the last");
	assert.equal(progress[0].loaded, 1);
	assert.equal(progress[1].loaded, 2);
	assert.equal(progress[1].total, 2);
	assert.deepEqual(progress.at(-1).partial, ["abc"], "final progress snapshot must match the returned sessions");
});

test("text helpers loaded for the session chain stay real", async () => {
	const agentDir = freshAgentDir("text");
	const { text } = await createSessionPipeline(workspaceRoot, agentDir);
	assert.equal(text.stripBom('\uFEFF{"a":1}'), '{"a":1}');
	const split = text.splitBom("\uFEFFbody");
	assert.equal(split.bom, "\uFEFF");
	assert.equal(split.text, "body");
	const untouched = text.splitBom("body");
	assert.equal(untouched.bom, "");
	assert.equal(untouched.text, "body");
});

rmSync(scratchRoot, { recursive: true, force: true });
mkdirSync(scratchRoot, { recursive: true });
try {
	for (const { name, run } of tests) {
		await run();
		console.log(`ok - ${name}`);
	}
	console.log(`# ${tests.length} cross-module checks passed`);
} finally {
	rmSync(scratchRoot, { recursive: true, force: true });
}
