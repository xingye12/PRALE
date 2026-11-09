#!/usr/bin/env node
/**
 * Cross-module regression for advanced/session-integrity/retransfer.
 *
 * Producer side: packages/coding-agent/src/migrations.ts
 *   A pre-existing destination must not abort the rest of the legacy batch.
 * Consumer side: packages/coding-agent/src/core/session-manager.ts
 *   A valid final JSONL record without a trailing newline must be retained
 *   exactly once, and only then is the newline appended.
 *
 * The script drives the real modules through .prale-eval/subject.mjs. Only
 * external IO boundaries provided by the helper are substituted; no source is
 * rewritten and no real time, randomness or network is used as evidence.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..");
const scratch = join(here, "scratch");

const header = (id, cwd) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2026-02-01T00:00:00.000Z",
		cwd,
	});

const userText = (id, parentId, text) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-02-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	});

const textsOf = (entries) =>
	entries
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message.content[0].text);

const idsOf = (entries) => entries.map((entry) => entry.id);

function resetScratch() {
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
}

function assertPipeline(entries, expectedIds, expectedTexts, label) {
	assert.equal(
		JSON.stringify(idsOf(entries)),
		JSON.stringify(expectedIds),
		`${label}: entries must be returned in file order exactly once`,
	);
	assert.equal(
		JSON.stringify(textsOf(entries)),
		JSON.stringify(expectedTexts),
		`${label}: Unicode payloads must be retained in order`,
	);
}

async function run() {
	resetScratch();
	const agentDir = join(scratch, "agent");
	mkdirSync(agentDir, { recursive: true });

	const { migration, session } = await createSessionPipeline(workspaceRoot, agentDir);

	// ---------------------------------------------------------------------
	// Producer: a colliding destination must not stop the remainder of the
	// legacy batch, and the colliding pair must stay byte-for-byte untouched.
	// ---------------------------------------------------------------------
	const collisionCwd = "/work/collision";
	const collisionSourceName = "a-collision.jsonl";
	const collisionSourcePath = join(agentDir, collisionSourceName);
	const collisionSourceBytes = `${header("collision-source", collisionCwd)}\n${userText(
		"collision-1",
		null,
		"η-source-payload",
	)}\n`;

	const collisionDestDir = join(agentDir, "sessions", "--work-collision--");
	const collisionDestPath = join(collisionDestDir, collisionSourceName);
	const collisionDestBytes = `${header("collision-destination", collisionCwd)}\n${userText(
		"collision-2",
		null,
		"already-present-payload",
	)}\n`;
	mkdirSync(collisionDestDir, { recursive: true });
	writeFileSync(collisionDestPath, collisionDestBytes);
	writeFileSync(collisionSourcePath, collisionSourceBytes);

	const betaName = "b-valid.jsonl";
	const betaSourcePath = join(agentDir, betaName);
	const betaBytes = `${header("beta-session", "/work/beta")}\n${userText("beta-1", null, "π-ünïcode")}\n${userText(
		"beta-2",
		"beta-1",
		"日本語",
	)}\n`;
	writeFileSync(betaSourcePath, betaBytes);

	const tailName = "c-tail.jsonl";
	const tailSourcePath = join(agentDir, tailName);
	const tailCwd = "/work/gamma";
	const tailPayloads = ["ordered-α", "\u00e9\u0301-combining", "tail-🧪-字"];
	const tailBytes = `${header("gamma-session", tailCwd)}\n${userText("gamma-1", null, tailPayloads[0])}\n${userText(
		"gamma-2",
		"gamma-1",
		tailPayloads[1],
	)}\n${userText("gamma-3", "gamma-2", tailPayloads[2])}`;
	assert.equal(tailBytes.endsWith("\n"), false, "fixture tail record must be unterminated");
	writeFileSync(tailSourcePath, tailBytes);

	migration.migrateSessionsFromAgentRoot();

	assert.equal(
		existsSync(collisionSourcePath),
		true,
		"colliding source must stay in the agent root when the destination exists",
	);
	assert.equal(
		readFileSync(collisionSourcePath, "utf8"),
		collisionSourceBytes,
		"colliding source bytes must be unchanged",
	);
	assert.equal(
		readFileSync(collisionDestPath, "utf8"),
		collisionDestBytes,
		"colliding destination bytes must be unchanged",
	);
	console.log("ok - collision keeps both files intact");

	assert.equal(
		existsSync(betaSourcePath),
		false,
		"the session after the collision must still be migrated out of the agent root",
	);
	const betaMigratedPath = join(agentDir, "sessions", "--work-beta--", betaName);
	assert.equal(existsSync(betaMigratedPath), true, "beta session must land in its encoded session directory");
	assert.equal(readFileSync(betaMigratedPath, "utf8"), betaBytes, "beta session bytes must be preserved");

	assert.equal(
		existsSync(tailSourcePath),
		false,
		"the final session of the batch must still be migrated after the collision",
	);
	const tailMigratedPath = join(agentDir, "sessions", "--work-gamma--", tailName);
	assert.equal(existsSync(tailMigratedPath), true, "tail session must land in its encoded session directory");
	assert.equal(readFileSync(tailMigratedPath, "utf8"), tailBytes, "tail session bytes must be preserved");
	console.log("ok - later sessions migrate after a collision");

	// ---------------------------------------------------------------------
	// Consumer across the module boundary: read the migrated session whose
	// final record has no newline. The record must appear once, then the
	// missing newline is appended, and a re-read must be stable.
	// ---------------------------------------------------------------------
	const tailEntries = session.loadEntriesFromFile(tailMigratedPath);
	assertPipeline(
		tailEntries,
		["gamma-session", "gamma-1", "gamma-2", "gamma-3"],
		tailPayloads,
		"migrated tail session",
	);
	assert.equal(
		readFileSync(tailMigratedPath, "utf8"),
		`${tailBytes}\n`,
		"the reader must append exactly one newline after the retained final record",
	);

	const reRead = session.loadEntriesFromFile(tailMigratedPath);
	assert.equal(
		JSON.stringify(reRead),
		JSON.stringify(tailEntries),
		"re-reading the repaired file must return the same entries",
	);
	assert.equal(
		readFileSync(tailMigratedPath, "utf8"),
		`${tailBytes}\n`,
		"re-reading must not append another newline",
	);
	console.log("ok - migrated tail record is retained exactly once and repaired idempotently");

	// ---------------------------------------------------------------------
	// Consumer: malformed lines are skipped, the valid tail survives.
	// ---------------------------------------------------------------------
	const mixedPath = join(scratch, "mixed.jsonl");
	const mixedBytes = `${header("mixed-session", "/work/mixed")}\nnot json at all\n${userText(
		"mixed-1",
		null,
		"skipped-before-α",
	)}\n{"type":"message","id":"truncated"\n${userText("mixed-2", "mixed-1", "final-β-🧪")}`;
	writeFileSync(mixedPath, mixedBytes);

	const mixedEntries = session.loadEntriesFromFile(mixedPath);
	assertPipeline(
		mixedEntries,
		["mixed-session", "mixed-1", "mixed-2"],
		["skipped-before-α", "final-β-🧪"],
		"session with malformed lines",
	);
	assert.equal(
		readFileSync(mixedPath, "utf8"),
		`${mixedBytes}\n`,
		"the valid unterminated tail is retained and terminated exactly once",
	);
	assert.equal(
		JSON.stringify(session.loadEntriesFromFile(mixedPath)),
		JSON.stringify(mixedEntries),
		"malformed-line handling must be idempotent across re-reads",
	);
	console.log("ok - malformed lines are skipped while the valid tail survives");

	// A completely terminated file is not rewritten.
	const terminatedPath = join(scratch, "terminated.jsonl");
	const terminatedBytes = `${header("terminated-session", "/work/terminated")}\n${userText(
		"terminated-1",
		null,
		"完整",
	)}\n`;
	writeFileSync(terminatedPath, terminatedBytes);
	const terminatedEntries = session.loadEntriesFromFile(terminatedPath);
	assertPipeline(terminatedEntries, ["terminated-session", "terminated-1"], ["完整"], "terminated session");
	assert.equal(
		readFileSync(terminatedPath, "utf8"),
		terminatedBytes,
		"a newline-terminated file must not be modified",
	);
	console.log("ok - newline-terminated files are untouched");

	// ---------------------------------------------------------------------
	// Consumer: multi-buffer reads must keep ordered Unicode payloads intact
	// and must not lose the final record at the streamed tail.
	// ---------------------------------------------------------------------
	const largeCwd = "/work/large";
	const padText = "字".repeat(400_000); // ~1.2 MB of three-byte code points
	const largeBytes = `${header("large-session", largeCwd)}\n${userText("large-1", null, padText)}\n${userText(
		"large-2",
		"large-1",
		"tail-after-多-buffer-🧪",
	)}`;
	const largePath = join(scratch, "large.jsonl");
	writeFileSync(largePath, largeBytes);
	assert.ok(Buffer.byteLength(largeBytes) > 1024 * 1024, "fixture must span multiple read buffers");

	const largeEntries = session.loadEntriesFromFile(largePath);
	assertPipeline(
		largeEntries,
		["large-session", "large-1", "large-2"],
		[padText, "tail-after-多-buffer-🧪"],
		"multi-buffer session",
	);
	assert.equal(
		readFileSync(largePath, "utf8"),
		`${largeBytes}\n`,
		"the multi-buffer tail record is retained and terminated once",
	);
	console.log("ok - multi-buffer Unicode stream retains ordered payloads and its tail");

	// ---------------------------------------------------------------------
	// Intact behavior: a file that is not a pi session is neither reparsed
	// nor rewritten (header validation still precedes tail repair).
	// ---------------------------------------------------------------------
	const foreignPath = join(scratch, "foreign.jsonl");
	const foreignBytes = '{"type":"message","id":"not-a-session"}';
	writeFileSync(foreignPath, foreignBytes);
	assert.equal(
		JSON.stringify(session.loadEntriesFromFile(foreignPath)),
		"[]",
		"non-session files must not be accepted as sessions",
	);
	assert.equal(readFileSync(foreignPath, "utf8"), foreignBytes, "non-session files must not be repaired");
	console.log("ok - non-session files remain untouched");
}

try {
	await run();
	console.log("regression: all checks passed");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
