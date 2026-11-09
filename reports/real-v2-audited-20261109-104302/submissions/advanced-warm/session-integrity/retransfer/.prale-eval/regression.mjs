#!/usr/bin/env node
/**
 * Cross-module regression for advanced/session-integrity/retransfer.
 *
 * Loads the real submitted migrations.ts and core/session-manager.ts through
 * the read-only subject helper. Only the agent-dir boundary, process.cwd and
 * the migration readdir ordering are supplied by the harness; all migration,
 * JSONL parsing, newline repair and session loading code is the real source.
 *
 * Scenario: a legacy agent-root batch whose first file collides with an
 * existing destination and whose last file is a valid session whose final
 * JSONL record has no trailing newline. The collision must not stop the
 * batch, and the migrated tail must read back exactly once, in order, with
 * ordered Unicode payloads, malformed-line skipping, one newline repair and
 * idempotent re-reads.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const workDir = join(root, ".prale-eval", "tmp", "retransfer");
const agentDir = join(workDir, "agent");
const collisionCwd = join(workDir, "project-collision");
const tailCwd = join(workDir, "project-tail");

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function sessionDirFor(cwd) {
	return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function customEntry(id, parentId, data) {
	return { type: "custom", id, parentId, timestamp: TIMESTAMP, customType: "legacy", data };
}

function writeSessionFile(path, header, records, { terminate = true } = {}) {
	const lines = [JSON.stringify(header), ...records.map((record) => (typeof record === "string" ? record : JSON.stringify(record)))];
	const content = lines.join("\n") + (terminate ? "\n" : "");
	writeFileSync(path, content, "utf8");
	return content;
}

function resetWorkDir() {
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
}

resetWorkDir();
try {
	// ---------------------------------------------------------------------
	// Fixture: collision first (sorted readdir), valid unterminated tail last.
	// ---------------------------------------------------------------------
	const collisionHeader = {
		type: "session",
		version: 3,
		id: "collision-source",
		timestamp: TIMESTAMP,
		cwd: collisionCwd,
	};
	const collisionSource = join(agentDir, "00-collision.jsonl");
	writeSessionFile(collisionSource, collisionHeader, [
		customEntry("source-entry", null, "source bytes must survive ✓"),
	]);

	// Existing destination with independent bytes must remain byte-identical.
	const collisionDir = sessionDirFor(collisionCwd);
	mkdirSync(collisionDir, { recursive: true });
	const collisionDestination = join(collisionDir, "00-collision.jsonl");
	writeSessionFile(
		collisionDestination,
		{ ...collisionHeader, id: "collision-destination" },
		[customEntry("destination-entry", null, "destination bytes must survive 保持")],
	);

	const sourceBytesBefore = readFileSync(collisionSource);
	const destinationBytesBefore = readFileSync(collisionDestination);

	const tailHeader = { type: "session", version: 3, id: "tail-session", timestamp: TIMESTAMP, cwd: tailCwd };
	const tailEntries = [
		customEntry("tail-1", null, "héllo — 世界 🌍"),
		"this malformed line must be skipped",
		customEntry("tail-2", "tail-1", "Ω ✅ 二番目"),
		customEntry("tail-3", "tail-2", "最終レコード 🚀"),
	];
	const tailSource = join(agentDir, "99-tail.jsonl");
	const tailContentBefore = writeSessionFile(tailSource, tailHeader, tailEntries, { terminate: false });
	assert.ok(tailContentBefore.endsWith("}"), "fixture tail must not end with a newline");

	const tailDestination = join(sessionDirFor(tailCwd), "99-tail.jsonl");

	// ---------------------------------------------------------------------
	// Real migration -> real session reader.
	// ---------------------------------------------------------------------
	const { migration, session } = await createSessionPipeline(root, agentDir);
	migration.migrateSessionsFromAgentRoot();

	// Collision: later migrations continue; both byte streams stay untouched.
	assert.ok(existsSync(collisionSource), "collision source must not be moved or removed");
	assert.ok(existsSync(collisionDestination), "collision destination must remain in place");
	assert.deepEqual(
		readFileSync(collisionSource),
		sourceBytesBefore,
		"collision source bytes must be unchanged",
	);
	assert.deepEqual(
		readFileSync(collisionDestination),
		destinationBytesBefore,
		"collision destination bytes must be unchanged",
	);

	// The file after the collision must still be migrated.
	assert.ok(existsSync(tailDestination), "valid session after the collision must be migrated");
	assert.equal(existsSync(tailSource), false, "migrated tail must no longer exist in the agent root");
	assert.equal(
		readFileSync(tailDestination, "utf8"),
		tailContentBefore,
		"migration must move the tail bytes without altering them",
	);

	// Reading the migrated file repairs only the missing trailing newline.
	const firstRead = session.loadEntriesFromFile(tailDestination);
	// Project records into host arrays: values created inside the subject VM have
	// sandbox-realm Array prototypes and would otherwise fail deep equality.
	const firstReadShape = Array.from(firstRead, (entry) => entry.id);
	assert.deepEqual(
		firstReadShape,
		["tail-session", "tail-1", "tail-2", "tail-3"],
		"reader must retain every valid record in order, including the unterminated final record",
	);
	assert.equal(
		firstRead.filter((entry) => entry.id === "tail-3").length,
		1,
		"unterminated final record must be retained exactly once",
	);
	assert.equal(firstRead.at(-1)?.id, "tail-3", "final record must remain the tail");
	assert.deepEqual(
		Array.from(firstRead)
			.filter((entry) => entry.type === "custom")
			.map((entry) => entry.data),
		["héllo — 世界 🌍", "Ω ✅ 二番目", "最終レコード 🚀"],
		"ordered Unicode payloads must be preserved and the malformed line skipped",
	);
	assert.equal(
		readFileSync(tailDestination, "utf8"),
		`${tailContentBefore}\n`,
		"reader must append exactly one newline after the unterminated final record",
	);

	// Idempotent re-read: same projection, no duplicate tail, no extra newline.
	const secondRead = session.loadEntriesFromFile(tailDestination);
	assert.deepEqual(
		Array.from(secondRead),
		Array.from(firstRead),
		"re-reading must return the same records exactly once",
	);
	assert.equal(
		readFileSync(tailDestination, "utf8"),
		`${tailContentBefore}\n`,
		"re-reading must not append another newline",
	);

	// Cross-check through the session-manager consumer boundary.
	const manager = session.SessionManager.open(tailDestination);
	assert.equal(manager.getHeader()?.id, "tail-session", "session header must be discovered");
	assert.deepEqual(
		Array.from(manager.getEntries(), (entry) => entry.id),
		["tail-1", "tail-2", "tail-3"],
		"SessionManager must expose the record before the repaired newline",
	);
	assert.equal(manager.getLeafId(), "tail-3", "leaf must be the formerly unterminated record");

	// Appending after the repaired newline must create a separate valid record.
	const appendedId = manager.appendCustomEntry("after-tail", { text: "appended ✓" });
	const afterAppend = session.loadEntriesFromFile(tailDestination);
	assert.deepEqual(
		Array.from(afterAppend, (entry) => entry.id),
		["tail-session", "tail-1", "tail-2", "tail-3", appendedId],
		"appending must not merge with or duplicate the repaired tail record",
	);
	assert.equal(afterAppend.filter((entry) => entry.id === "tail-3").length, 1, "tail record must stay unique");

	console.log("session-integrity/retransfer regression: passed");
} finally {
	rmSync(workDir, { recursive: true, force: true });
	try {
		rmdirSync(join(root, ".prale-eval", "tmp"));
	} catch {
		// Another local run still owns the shared parent; leave it in place.
	}
}
