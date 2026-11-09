/**
 * Cross-module regression for the mixed legacy session batch incident.
 *
 * Loads the real production graph through the read-only `subject.mjs` helper:
 *   migrations.ts (real) -> utils/text.ts + utils/paths.ts (real) -> session-manager.ts (real)
 * Only the agent-dir boundary and the directory-entry ordering are supplied by
 * the pipeline; all parsing, moving, reading, newline repair and re-reading
 * execute from the submitted sources against real files under .prale-eval/.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const root = process.cwd();
const workspace = path.join(root, ".prale-eval", ".session-integrity-tmp");
const agentDir = path.join(workspace, "agent");
const collisionCwd = path.join(workspace, "collision-project");
const validCwd = path.join(workspace, "valid-project");

/** Same on-disk encoding used by the session directory layout. */
function safeSegment(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function header(id, cwd) {
	return { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd };
}

function message(id, parentId, content, timestamp) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2025-01-01T00:00:0${timestamp}.000Z`,
		message: { role: "user", content, timestamp },
	};
}

function line(entry) {
	return JSON.stringify(entry);
}

/** Values produced inside the VM graph carry that realm's prototypes; copy them
 * into plain host structures before structural comparison. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function cleanup() {
	fs.rmSync(workspace, { recursive: true, force: true });
}

async function main() {
	cleanup();
	fs.mkdirSync(agentDir, { recursive: true });

	const pipeline = await createSessionPipeline(root, agentDir);

	// ---------------------------------------------------------------------
	// Batch fixture: collision first, then a valid Unicode session whose last
	// record has no trailing newline, then an unmigratable malformed file.
	// `readdirSync` ordering is supplied by the pipeline, so "a-" runs first.
	// ---------------------------------------------------------------------
	const collisionSource = `${line(header("collision-source", collisionCwd))}\n${line(
		message("collision-entry", null, "source 保真 🧷", 1),
	)}\n`;
	const collisionDestination = `${line(header("existing-destination", collisionCwd))}\n${line(
		message("destination-entry", null, "destination 原样 🔒", 2),
	)}\n`;
	const collisionTargetDir = path.join(agentDir, "sessions", safeSegment(collisionCwd));
	fs.mkdirSync(collisionTargetDir, { recursive: true });
	const collisionSourcePath = path.join(agentDir, "a-colliding.jsonl");
	const collisionDestinationPath = path.join(collisionTargetDir, "a-colliding.jsonl");
	fs.writeFileSync(collisionSourcePath, collisionSource);
	fs.writeFileSync(collisionDestinationPath, collisionDestination);

	const validEntries = [
		header("valid-session", validCwd),
		message("m1", null, "héllo 🌍 日本語", 1),
		message("m2", "m1", "naïve façade ✨", 2),
		message("m3", "m2", "最后一条 🚀", 3),
	];
	// A malformed physical line sits between valid records and must be skipped
	// without disturbing the order of the surrounding Unicode payloads.
	const validLines = [line(validEntries[0]), line(validEntries[1]), "{ this is not json", line(validEntries[2]), line(validEntries[3])];
	const validContent = validLines.join("\n"); // deliberately no trailing newline
	const validSourcePath = path.join(agentDir, "b-valid.jsonl");
	fs.writeFileSync(validSourcePath, validContent);

	const malformedContent = "not a session header\n";
	const malformedPath = path.join(agentDir, "c-malformed.jsonl");
	fs.writeFileSync(malformedPath, malformedContent);

	const validTargetDir = path.join(agentDir, "sessions", safeSegment(validCwd));
	const validTargetPath = path.join(validTargetDir, "b-valid.jsonl");

	// ---------------------------------------------------------------------
	// 1. Migration must skip only the colliding file and continue the batch.
	// ---------------------------------------------------------------------
	pipeline.migration.migrateSessionsFromAgentRoot();

	assert.ok(fs.existsSync(validTargetPath), "migration must continue past a colliding file and move the later valid session");
	assert.equal(fs.existsSync(validSourcePath), false, "the migrated session must no longer sit in the agent root");
	assert.deepEqual(fs.readFileSync(validTargetPath), Buffer.from(validContent), "migration must move the session bytes unchanged (no newline yet)");

	// Colliding source and destination must both keep their exact original bytes.
	assert.ok(fs.existsSync(collisionSourcePath), "a collision must leave the colliding source in place");
	assert.deepEqual(
		fs.readFileSync(collisionSourcePath),
		Buffer.from(collisionSource),
		"colliding source bytes must remain unchanged",
	);
	assert.deepEqual(
		fs.readFileSync(collisionDestinationPath),
		Buffer.from(collisionDestination),
		"colliding destination bytes must remain unchanged",
	);

	// The unmigratable file is skipped, untouched, and does not abort the batch.
	assert.deepEqual(fs.readFileSync(malformedPath), Buffer.from(malformedContent), "malformed headers must stay untouched");

	// Migration and session modules must agree on the session directory layout.
	assert.equal(
		path.join(pipeline.session.getDefaultSessionDir(validCwd), "b-valid.jsonl"),
		validTargetPath,
		"migration and session manager must encode the same session directory",
	);

	// A second batch run is a no-op: collisions stay skipped, bytes stay put.
	pipeline.migration.migrateSessionsFromAgentRoot();
	assert.deepEqual(fs.readFileSync(collisionSourcePath), Buffer.from(collisionSource));
	assert.deepEqual(fs.readFileSync(collisionDestinationPath), Buffer.from(collisionDestination));
	assert.deepEqual(fs.readFileSync(validTargetPath), Buffer.from(validContent));

	// ---------------------------------------------------------------------
	// 2. Reading the moved file must keep the unterminated tail record exactly
	//    once, skip the malformed line, and repair only the trailing newline.
	// ---------------------------------------------------------------------
	const entries = plain(pipeline.session.loadEntriesFromFile(validTargetPath));
	assert.deepEqual(
		entries.map((entry) => entry.id),
		["valid-session", "m1", "m2", "m3"],
		"the unterminated final record must be retained once, in order, after malformed lines are skipped",
	);
	assert.deepEqual(
		entries.slice(1).map((entry) => entry.message.content),
		["héllo 🌍 日本語", "naïve façade ✨", "最后一条 🚀"],
		"ordered Unicode payloads must survive the read unchanged",
	);
	assert.deepEqual(entries, validEntries, "parsed entries must match the written records");
	assert.deepEqual(fs.readFileSync(validTargetPath), Buffer.from(`${validContent}\n`), "exactly one newline must be appended");

	// Idempotent re-read: same records, no duplicate tail, no extra newline.
	const reread = plain(pipeline.session.loadEntriesFromFile(validTargetPath));
	assert.deepEqual(reread, entries, "re-reading must return the same entries");
	assert.deepEqual(
		fs.readFileSync(validTargetPath),
		Buffer.from(`${validContent}\n`),
		"re-reading must not append another newline",
	);

	// The session manager must see the same tail record through its own loader.
	const manager = pipeline.session.SessionManager.open(validTargetPath);
	assert.equal(manager.getSessionId(), "valid-session");
	assert.deepEqual(Array.from(manager.getEntries(), (entry) => entry.id), ["m1", "m2", "m3"]);
	assert.equal(manager.getEntries()[2].message.content, "最后一条 🚀");

	// ---------------------------------------------------------------------
	// 3. Tail retention across the 1 MiB read boundary: a multi-byte sequence
	//    split between chunks must decode in order and stay exactly once.
	// ---------------------------------------------------------------------
	const boundaryDir = path.join(workspace, "boundary");
	fs.mkdirSync(boundaryDir, { recursive: true });
	const boundaryPath = path.join(boundaryDir, "tail.jsonl");
	const padLine = line({
		type: "message",
		id: "pad",
		parentId: null,
		timestamp: "2025-01-01T00:00:01.000Z",
		message: { role: "user", content: "pad", timestamp: 1 },
	});
	const headerLine = line(header("boundary-session", boundaryDir));
	const tailPrefix = line({
		type: "message",
		id: "tail",
		parentId: "pad",
		timestamp: "2025-01-01T00:00:02.000Z",
		message: { role: "user", content: "", timestamp: 2 },
	});
	// Split the tail record's JSON so the emoji starts at the last byte of the
	// first 1 MiB read chunk. Its UTF-8 sequence therefore spans two chunks.
	const contentMarker = ',"message":{"role":"user","content":"';
	const beforeEmoji = `${tailPrefix.slice(0, tailPrefix.indexOf(contentMarker) + contentMarker.length)}`;
	const afterEmoji = `"}}`;
	const consumed = Buffer.byteLength(`${headerLine}\n${padLine}\n`) + Buffer.byteLength(beforeEmoji);
	const padding = 1024 * 1024 - 1 - consumed;
	assert.ok(padding > 0, "boundary fixture must fit before the first chunk boundary");
	const boundaryContent = "a".repeat(padding) + "🌍" + "terminal-尾";
	const boundaryFile = `${headerLine}\n${padLine}\n${beforeEmoji}${boundaryContent}${afterEmoji}`;
	fs.writeFileSync(boundaryPath, boundaryFile);

	const boundaryEntries = plain(pipeline.session.loadEntriesFromFile(boundaryPath));
	assert.deepEqual(
		boundaryEntries.map((entry) => entry.id),
		["boundary-session", "pad", "tail"],
	);
	assert.equal(
		boundaryEntries[2].message.content,
		boundaryContent,
		"a multi-byte sequence split across read chunks must decode in order",
	);
	assert.deepEqual(fs.readFileSync(boundaryPath), Buffer.from(`${boundaryFile}\n`), "the split boundary tail must gain exactly one newline");
	assert.deepEqual(
		plain(pipeline.session.loadEntriesFromFile(boundaryPath)),
		boundaryEntries,
		"boundary re-read must be idempotent",
	);

	// The migration batch left the collision and malformed inputs byte-identical.
	assert.deepEqual(fs.readFileSync(collisionSourcePath), Buffer.from(collisionSource));
	assert.deepEqual(fs.readFileSync(collisionDestinationPath), Buffer.from(collisionDestination));
	assert.deepEqual(fs.readFileSync(malformedPath), Buffer.from(malformedContent));

	// text.ts is linked into the migration path; its BOM split stays stable.
	const bom = pipeline.text.splitBom("\uFEFFcontent");
	assert.equal(bom.bom, "\uFEFF");
	assert.equal(bom.text, "content");
	assert.equal(pipeline.text.stripBom("\uFEFFcontent"), "content");
	assert.equal(pipeline.text.stripBom("content"), "content");

	console.log("session-integrity regression: all assertions passed");
}

let failure;
try {
	await main();
} catch (error) {
	failure = error;
} finally {
	cleanup();
}
if (failure) throw failure;
