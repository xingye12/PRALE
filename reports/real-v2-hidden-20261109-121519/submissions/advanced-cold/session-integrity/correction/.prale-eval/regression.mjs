#!/usr/bin/env -S node --experimental-vm-modules
/**
 * Cross-module regression coverage for session integrity:
 * real migrations.ts -> real fs boundary -> real session-manager.ts reader.
 *
 * Two observable contracts are asserted:
 * 1. A legacy session migration must never clobber existing destination bytes;
 *    both the colliding destination and the original file survive, and every
 *    other legacy session is still migrated.
 * 2. A session reader must reject a header that is not a session header with a
 *    string `id` *before* repairing a missing final newline, while still
 *    accepting valid headers and still newline-terminating valid unterminated
 *    final records.
 *
 * Only node:fs (real, sandboxed under .prale-eval/) and the module loader from
 * subject.mjs are involved; no network, time or randomness decides the result.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const root = process.cwd();
const base = path.join(root, ".prale-eval", "tmp");
const agentDir = path.join(base, "agent");
const cwdA = path.join(base, "project-a");
const cwdB = path.join(base, "project-b");

const legacyName = "2025-01-01_legacy-collision.jsonl";
const freshName = "2025-01-01_fresh-session.jsonl";

const headerLine = (cwd, id, extra = "") =>
	`{"type":"session","version":3,"id":"${id}","timestamp":"2025-01-01T00:00:00Z","cwd":${JSON.stringify(cwd)}${extra}}`;
const messageLine = (id, text) =>
	`{"type":"message","id":"${id}","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"${text}","timestamp":1}}`;
const sessionDirName = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const destinationBytes = `${headerLine(cwdA, "existing-destination")}\n${messageLine("dest-1", "destination survives")}\n`;
const legacyBytes = `${headerLine(cwdA, "legacy-source")}\n${messageLine("legacy-1", "legacy source survives")}\n`;
const freshBytes = `${headerLine(cwdB, "fresh-source")}\n${messageLine("fresh-1", "fresh migrated")}`;

function writeFixture(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function read(filePath) {
	return fs.readFileSync(filePath, "utf8");
}

function exists(filePath) {
	return fs.existsSync(filePath);
}

async function main() {
	fs.rmSync(base, { recursive: true, force: true });
	try {
		const destinationDir = path.join(agentDir, "sessions", sessionDirName(cwdA));
		const freshDestinationDir = path.join(agentDir, "sessions", sessionDirName(cwdB));
		const destinationPath = path.join(destinationDir, legacyName);
		const legacySourcePath = path.join(agentDir, legacyName);
		const freshSourcePath = path.join(agentDir, freshName);
		const freshDestinationPath = path.join(freshDestinationDir, freshName);

		writeFixture(destinationPath, destinationBytes);
		writeFixture(legacySourcePath, legacyBytes);
		writeFixture(freshSourcePath, freshBytes);

		const { migration, session } = await createSessionPipeline(root, agentDir);

		// ---- Contract 1: existing destination bytes always win -------------
		migration.migrateSessionsFromAgentRoot();

		assert.equal(
			read(destinationPath),
			destinationBytes,
			"migration must not overwrite the existing destination session file",
		);
		assert.ok(exists(legacySourcePath), "the collided legacy source file must remain in place");
		assert.equal(read(legacySourcePath), legacyBytes, "the collided legacy source bytes must be preserved");

		// ---- ...while unrelated legacy sessions still migrate --------------
		assert.ok(!exists(freshSourcePath), "a non-colliding legacy session must be migrated");
		assert.equal(read(freshDestinationPath), freshBytes, "the migrated session keeps its exact bytes");

		// Re-running the migration is stable: neither side of the collision moves.
		migration.migrateSessionsFromAgentRoot();
		assert.equal(read(destinationPath), destinationBytes);
		assert.equal(read(legacySourcePath), legacyBytes);
		assert.ok(exists(freshDestinationPath));

		// ---- Cross-module: the real reader repairs the migrated file -------
		const migratedEntries = session.loadEntriesFromFile(freshDestinationPath);
		assert.equal(migratedEntries.length, 2, "the migrated session must load header and record");
		assert.equal(migratedEntries[0].id, "fresh-source");
		assert.equal(migratedEntries[1].type, "message");
		assert.equal(read(freshDestinationPath), `${freshBytes}\n`, "a valid unterminated final record is terminated");

		// ---- Contract 2: invalid headers are rejected without rewriting ----
		const invalidHeaders = {
			"numeric-id.jsonl": `${headerLine(cwdA, 42)}\n${messageLine("numeric-1", "should never be repaired")}`.replace(
				'"id":"42"',
				'"id":42',
			),
			"missing-id.jsonl": `{"type":"session","version":3,"timestamp":"2025-01-01T00:00:00Z","cwd":${JSON.stringify(cwdA)}}\n${messageLine("missing-1", "no id")}`,
			"non-session.jsonl": `${messageLine("plain-1", "not a session")}`,
		};

		for (const [fileName, content] of Object.entries(invalidHeaders)) {
			const filePath = path.join(base, "invalid", fileName);
			writeFixture(filePath, content);
			const rejected = session.loadEntriesFromFile(filePath);
			assert.ok(Array.isArray(rejected), `${fileName}: loadEntriesFromFile must return an array`);
			assert.equal(rejected.length, 0, `${fileName}: a header without a string session id must be rejected`);
			assert.equal(
				read(filePath),
				content,
				`${fileName}: rejecting an invalid header must not rewrite the file (no newline repair)`,
			);
		}

		// The real SessionManager must refuse the invalid file without rewriting it.
		const managerPath = path.join(base, "invalid", "numeric-id.jsonl");
		const managerBytes = read(managerPath);
		assert.throws(
			() => session.SessionManager.open(managerPath, path.dirname(managerPath)),
			/not a valid/,
			"SessionManager.open must reject a non-empty file without a valid session header",
		);
		assert.equal(read(managerPath), managerBytes, "SessionManager.open must not rewrite an invalid header file");

		// ---- Valid headers are still accepted, repaired when unterminated ---
		const validUnterminated = path.join(base, "valid", "valid-unterminated.jsonl");
		const validBytes = `${headerLine(cwdB, "valid-session")}\n${messageLine("valid-1", "valid unterminated")}`;
		writeFixture(validUnterminated, validBytes);
		const validEntries = session.loadEntriesFromFile(validUnterminated);
		assert.equal(validEntries.length, 2, "a valid unterminated session must load both records");
		assert.equal(validEntries[0].id, "valid-session");
		assert.equal(read(validUnterminated), `${validBytes}\n`, "a valid unterminated final record must be terminated");

		const validTerminated = path.join(base, "valid", "valid-terminated.jsonl");
		const terminatedBytes = `${headerLine(cwdB, "terminated-session")}\n${messageLine("terminated-1", "ok")}\n`;
		writeFixture(validTerminated, terminatedBytes);
		assert.equal(session.loadEntriesFromFile(validTerminated).length, 2);
		assert.equal(read(validTerminated), terminatedBytes, "an already terminated file must not be modified");

		console.log("session integrity regression: ok");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
}

await main();
