#!/usr/bin/env node
/**
 * Regression coverage for advanced/session-integrity/retransfer.
 *
 * Incident: a mixed legacy batch starts with a destination collision and ends
 * with a valid session whose last JSONL record has no trailing newline.
 *
 * Behaviors asserted (all through the real submitted modules, linked by
 * .prale-eval/subject.mjs):
 *  1. migrations.migrateSessionsFromAgentRoot() keeps migrating the rest of the
 *     batch after a colliding destination, and leaves both the colliding source
 *     and the pre-existing destination bytes untouched.
 *  2. session-manager.loadEntriesFromFile() retains the unterminated final
 *     record exactly once, keeps record order and Unicode payloads intact,
 *     skips malformed lines, appends exactly one newline, and is idempotent on
 *     re-read.
 *  3. SessionManager.open()/appendMessage() (cross-module: migration ->
 *     session) resume the migrated session without dropping or duplicating the
 *     recovered tail record.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(evalDir, "..");
const tmpParent = path.join(evalDir, ".tmp");

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

/** Session header entry (version 3 keeps the reader out of entry migrations). */
function sessionHeader(id, cwd) {
	return { type: "session", version: 3, id, timestamp: TIMESTAMP, cwd };
}

function userMessage(id, parentId, text) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	};
}

function assistantMessage(id, parentId, text) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "fixture",
			provider: "fixture",
			model: "fixture",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

const line = (entry) => `${JSON.stringify(entry)}\n`;

/** Module values come from the VM realm, so compare plain main-realm copies. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Fresh scratch tree inside .prale-eval so validation never leaves the workspace. */
function createScratch() {
	fs.mkdirSync(tmpParent, { recursive: true });
	const work = fs.mkdtempSync(path.join(tmpParent, "run-"));
	const agentDir = path.join(work, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	return { work, agentDir };
}

async function main() {
	const { work, agentDir } = createScratch();
	try {
		const { migration, session } = await createSessionPipeline(workspaceRoot, agentDir);

		// ---------------------------------------------------------------
		// Fixtures: legacy sessions sitting directly in the agent root.
		// Readdir order is normalized by the helper, so "a-collide.jsonl" is
		// processed first and "z-later.jsonl" is the tail of the batch.
		// ---------------------------------------------------------------
		const collideCwd = path.join(work, "project-collision");
		const laterCwd = path.join(work, "project-tail");

		const collideDestinationBytes = line(sessionHeader("destination-session", collideCwd));
		const collideSourceBytes =
			line(sessionHeader("collide-session", collideCwd)) + line(userMessage("c0000001", null, "colliding 批次"));

		// The tail session: header, unicode records, one malformed line, and a
		// final valid record with no newline.
		const laterHeader = sessionHeader("later-session", laterCwd);
		const first = userMessage("b0000001", null, "第一行 ✓ héllo wörld");
		const second = assistantMessage("b0000002", "b0000001", "响应 with 多字节 🎉 payload");
		const tail = userMessage("b0000003", "b0000002", "终章 — tail 末尾 🌱");
		const laterSourceBytes =
			line(laterHeader) + line(first) + "this line is not valid json\n" + line(second) + JSON.stringify(tail);

		// Pre-existing destination for the colliding file (same basename).
		const collideDestinationDir = path.join(
			agentDir,
			"sessions",
			`--${collideCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		);
		fs.mkdirSync(collideDestinationDir, { recursive: true });
		const collideDestinationPath = path.join(collideDestinationDir, "a-collide.jsonl");
		fs.writeFileSync(collideDestinationPath, collideDestinationBytes);

		const collideSourcePath = path.join(agentDir, "a-collide.jsonl");
		const laterSourcePath = path.join(agentDir, "z-later.jsonl");
		fs.writeFileSync(collideSourcePath, collideSourceBytes);
		fs.writeFileSync(laterSourcePath, laterSourceBytes);
		// Unrelated file in the agent root must not be touched either.
		fs.writeFileSync(path.join(agentDir, "notes.txt"), "not a session\n");

		// ---------------------------------------------------------------
		// 1. Migration batch: collision first, valid session last.
		// ---------------------------------------------------------------
		migration.migrateSessionsFromAgentRoot();

		const expectedLaterDir = session.getDefaultSessionDir(laterCwd, agentDir);
		const migratedLaterPath = path.join(expectedLaterDir, "z-later.jsonl");

		assert.ok(
			fs.existsSync(migratedLaterPath),
			"a colliding destination must not abort the batch: z-later.jsonl was never migrated",
		);
		assert.equal(
			fs.existsSync(laterSourcePath),
			false,
			"the migrated tail session must be moved out of the agent root",
		);
		assert.equal(
			fs.readFileSync(migratedLaterPath, "utf8"),
			laterSourceBytes,
			"migration must move the tail session byte-for-byte (unterminated final record preserved)",
		);

		assert.ok(fs.existsSync(collideSourcePath), "the colliding source file must be left in place");
		assert.equal(
			fs.readFileSync(collideSourcePath, "utf8"),
			collideSourceBytes,
			"the colliding source bytes must be unchanged",
		);
		assert.equal(
			fs.readFileSync(collideDestinationPath, "utf8"),
			collideDestinationBytes,
			"the pre-existing destination bytes must be unchanged",
		);
		assert.equal(
			fs.readFileSync(path.join(agentDir, "notes.txt"), "utf8"),
			"not a session\n",
			"non-session files in the agent root must be ignored",
		);

		// ---------------------------------------------------------------
		// 2. Read the migrated tail: final record kept exactly once, newline added.
		// ---------------------------------------------------------------
		const firstRead = session.loadEntriesFromFile(migratedLaterPath);
		assert.equal(
			firstRead.length,
			4,
			`expected header + two valid records + the unterminated tail record, got ${firstRead.length}`,
		);
		assert.deepEqual(
			plain(firstRead),
			[laterHeader, first, second, tail],
			"records must keep file order, skip malformed lines, and preserve unicode payloads",
		);
		assert.equal(
			firstRead.filter((entry) => entry.id === "b0000003").length,
			1,
			"the unterminated final record must be retained exactly once",
		);

		const repairedBytes = fs.readFileSync(migratedLaterPath, "utf8");
		assert.equal(
			repairedBytes,
			`${laterSourceBytes}\n`,
			"reading must append exactly one newline after the recovered final record",
		);

		const secondRead = session.loadEntriesFromFile(migratedLaterPath);
		assert.deepEqual(plain(secondRead), plain(firstRead), "re-reading the repaired file must be idempotent");
		assert.equal(
			fs.readFileSync(migratedLaterPath, "utf8"),
			repairedBytes,
			"a second read must not append another newline or rewrite the file",
		);

		// ---------------------------------------------------------------
		// 3. Cross-module resume: migration -> reader -> SessionManager append.
		// ---------------------------------------------------------------
		const resumed = session.SessionManager.open(migratedLaterPath, agentDir);
		assert.equal(resumed.getSessionId(), "later-session", "the migrated session must resume by its header id");
		assert.deepEqual(
			plain(resumed.getEntries().map((entry) => entry.id)),
			["b0000001", "b0000002", "b0000003"],
			"the resumed session must expose the recovered tail entry",
		);
		assert.equal(resumed.getLeafId(), "b0000003", "the recovered tail record must become the active leaf");

		const appendedId = resumed.appendMessage({
			role: "user",
			content: [{ type: "text", text: "继续 appended ✚" }],
			timestamp: 3,
		});

		const afterAppend = session.loadEntriesFromFile(migratedLaterPath);
		assert.equal(afterAppend.length, 5, "appending after the repair must add exactly one record to header + 3 + 1");
		assert.equal(afterAppend.filter((entry) => entry.id === "b0000003").length, 1, "the tail record must not duplicate");
		assert.deepEqual(
			plain(afterAppend.map((entry) => entry.id)),
			["later-session", "b0000001", "b0000002", "b0000003", appendedId],
			"all records must stay in append order after the newline repair",
		);
		const appendedEntry = afterAppend.find((entry) => entry.id === appendedId);
		assert.equal(appendedEntry?.parentId, "b0000003", "the appended record must continue the recovered tail");
		assert.equal(appendedEntry?.message.content[0].text, "继续 appended ✚", "unicode payload must round-trip");
		assert.ok(
			fs.readFileSync(migratedLaterPath, "utf8").endsWith("\n"),
			"the persisted session file must stay newline-terminated",
		);

		console.log("session-integrity/retransfer regression: ok");
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
		try {
			fs.rmdirSync(tmpParent);
		} catch {
			// Another concurrent run still owns the shared parent directory.
		}
	}
}

await main();
