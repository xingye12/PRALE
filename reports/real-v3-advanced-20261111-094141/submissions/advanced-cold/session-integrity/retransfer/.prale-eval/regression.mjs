/**
 * Cross-module regression for "resume a mixed legacy batch without dropping its tail".
 *
 * Real production modules linked by this script (no copies, no adapters):
 *   - packages/coding-agent/src/core/session-manager.ts   (JSONL session reader/producer)
 *   - packages/coding-agent/src/core/messages.ts          (context message construction)
 *   - packages/coding-agent/src/utils/paths.ts            (path normalization boundary)
 *
 * Boundary fakes supplied by this script:
 *   - `../config.ts` exports (APP_NAME/getAgentDir/getSessionsDir)
 *   - `@earendil-works/pi-ai` exports (uuidv7 + getCurrentSystemMessage)
 *   - `./child-process.ts` (spawnProcessSync, only used by unrelated paths helpers)
 *   - `crypto.randomUUID` (scripted id generator, so id collisions are deterministic)
 *   - the `Date` global inside the module graph (a fixed clock, so no real time participates)
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGraph } from "./subject.mjs";

const root = process.cwd();
const tmp = path.join(root, ".prale-eval", "tmp");

const SESSION_MANAGER = "packages/coding-agent/src/core/session-manager.ts";
const MESSAGES = "packages/coding-agent/src/core/messages.ts";
const PATHS = "packages/coding-agent/src/utils/paths.ts";

const HEADER_TS = "2026-01-02T03:04:05.678Z";
const CLOCK_START = Date.parse(HEADER_TS);

/** Deterministic clock shared with the module graph; no real time is read. */
const clock = { now: CLOCK_START };

/** Session ids handed to SessionManager.newSession()/createBranchedSession(). */
let sessionIdCounter = 0;
function nextSessionId() {
	sessionIdCounter += 1;
	return `session-${sessionIdCounter}`;
}
// The module graph reaches the fake clock through this binding object.
const uuidv7 = () => nextSessionId();
uuidv7.clock = clock;

/** Scripted `crypto.randomUUID` queue, consumed by the legacy id generator. */
let randomUuids = [];
function randomUUID() {
	return randomUuids.length > 0 ? randomUuids.shift() : "ffffffff-0000-4000-8000-000000000000";
}

const dateTrailer = `
;{
\tconst RealDate = Date;
\tconst fakeClock = uuidv7.clock;
\tclass FixedDate extends RealDate {
\t\tconstructor(...args) {
\t\t\tif (args.length === 0) super(fakeClock.now);
\t\t\telse super(...args);
\t\t}
\t\tstatic now() {
\t\t\treturn fakeClock.now;
\t\t}
\t}
\tglobalThis.Date = FixedDate;
}
`;

function removeTree(target) {
	fs.rmSync(target, { recursive: true, force: true });
}

function headerLine(id, cwd, version) {
	const header = { type: "session", id, timestamp: HEADER_TS, cwd };
	if (version !== undefined) header.version = version;
	return JSON.stringify(header);
}

function messageLine(id, text, parentId = null, timestamp = HEADER_TS) {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: CLOCK_START },
	});
}

function readLines(file) {
	return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

function parsedRecords(file) {
	return readLines(file).map((line) => JSON.parse(line));
}

function textOf(entry) {
	return list(entry.message.content)
		.map((part) => part.text)
		.join("");
}

/** Cross-realm values (created inside the module graph) are copied into host collections. */
function list(value) {
	return Array.from(value);
}

/** Plain structural copy of a cross-realm value, for strict deep comparison. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

async function loadModules() {
	const graph = createGraph(
		root,
		[SESSION_MANAGER, MESSAGES, PATHS],
		{
			APP_NAME: "pi",
			getAgentDir: () => path.join(tmp, "agent"),
			getSessionsDir: () => path.join(tmp, "sessions-root"),
			spawnProcessSync: () => {
				throw new Error("Unexpected boundary: child-process");
			},
			getCurrentSystemMessage: () => undefined,
			uuidv7,
		},
		{ [SESSION_MANAGER]: { randomUUID } },
		{ [SESSION_MANAGER]: dateTrailer },
	);
	return {
		sessionManager: await graph.module(SESSION_MANAGER),
		messages: await graph.module(MESSAGES),
		paths: await graph.module(PATHS),
	};
}

function assertReadableMessages(modules) {
	// messages.ts is real linked code: it must be reachable from the session-manager boundary.
	assert.equal(typeof modules.messages.createCustomMessage, "function");
	assert.equal(modules.messages.createBranchSummaryMessage("summary", null, HEADER_TS).role, "branchSummary");
}

async function main() {
	removeTree(tmp);
	fs.mkdirSync(tmp, { recursive: true });

	const modules = await loadModules();
	const { SessionManager, loadEntriesFromFile, migrateSessionEntries } = modules.sessionManager;
	assert.equal(typeof SessionManager, "function");
	assert.equal(typeof loadEntriesFromFile, "function");
	assert.equal(typeof modules.paths.resolvePath, "function");
	assertReadableMessages(modules);

	await testReadsTailRecordExactlyOnce(loadEntriesFromFile);
	await testSkipsMalformedLinesAndKeepsUnicodeOrder(loadEntriesFromFile);
	await testResumeRepairsTailBeforeAppending(modules);
	await testBatchTransferWithCollision(modules);
	await testLegacyBatchMigration(modules, migrateSessionEntries);
}

/** Reading a file whose last record has no newline keeps it exactly once, then appends one. */
async function testReadsTailRecordExactlyOnce(loadEntriesFromFile) {
	const dir = path.join(tmp, "read");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "tail.jsonl");
	const content = [headerLine("tail", dir, 3), messageLine("entry-1", "first", null)].join("\n") + "\n";
	// The valid final record is deliberately not newline terminated.
	const unterminated = `${content}${messageLine("entry-2", "second", "entry-1")}`;
	fs.writeFileSync(file, unterminated);

	const entries = loadEntriesFromFile(file);
	assert.equal(entries.length, 3, "the unterminated final record must not be dropped");
	assert.deepEqual(
		list(entries).map((entry) => entry.type),
		["session", "message", "message"],
	);
	assert.equal(entries[2].id, "entry-2");
	assert.equal(entries[2].parentId, "entry-1");
	assert.equal(textOf(entries[2]), "second");

	// The repair appends exactly one newline after the retained record.
	assert.equal(fs.readFileSync(file, "utf8"), `${unterminated}\n`);
	const records = parsedRecords(file);
	assert.equal(records.filter((record) => record.id === "entry-2").length, 1, "final record appears exactly once");

	// Re-reading is idempotent: same entries, same bytes, no duplicated record and no extra newline.
	const reread = loadEntriesFromFile(file);
	assert.deepEqual(
		list(reread).map((entry) => entry.id),
		["tail", "entry-1", "entry-2"],
	);
	assert.equal(fs.readFileSync(file, "utf8"), `${unterminated}\n`);
}

/** Malformed lines are skipped and Unicode payloads keep file order. */
async function testSkipsMalformedLinesAndKeepsUnicodeOrder(loadEntriesFromFile) {
	const dir = path.join(tmp, "mixed");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "mixed.jsonl");
	const payloads = ["héllo 🙂", "終わり", "z\u0301-last"];
	const content =
		`${headerLine("mixed", dir, 3)}\n` +
		"not json at all\n" +
		`${messageLine("entry-1", payloads[0], null)}\n` +
		'{"type":"message","id":"broken"\n' +
		`${messageLine("entry-2", payloads[1], "entry-1")}\n` +
		`${messageLine("entry-3", payloads[2], "entry-2")}`;
	fs.writeFileSync(file, content);

	const entries = loadEntriesFromFile(file);
	assert.deepEqual(
		list(entries).map((entry) => entry.id),
		["mixed", "entry-1", "entry-2", "entry-3"],
		"malformed lines must be skipped without losing ordered records",
	);
	assert.deepEqual(
		list(entries).slice(1).map(textOf),
		payloads,
		"Unicode payloads must be preserved in file order",
	);
	assert.equal(fs.readFileSync(file, "utf8"), `${content}\n`);
}

/** Resuming repairs the tail first, so the next appended record starts on its own line. */
async function testResumeRepairsTailBeforeAppending(modules) {
	const { SessionManager } = modules.sessionManager;
	const dir = path.join(tmp, "resume");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "resume.jsonl");
	const content =
		`${headerLine("resume", dir, 3)}\n` +
		`${messageLine("entry-1", "retained", null)}\n` +
		`${messageLine("entry-2", "tail", "entry-1")}`;
	fs.writeFileSync(file, content);

	const session = SessionManager.open(file, dir);
	assert.deepEqual(
		list(session.getEntries()).map((entry) => entry.id),
		["entry-1", "entry-2"],
		"resume must keep the tail entry",
	);
	assert.equal(session.getLeafId(), "entry-2");

	const appendedId = session.appendMessage({
		role: "user",
		content: [{ type: "text", text: "appended" }],
		timestamp: CLOCK_START,
	});

	// Every physical line must remain parseable: the retained tail was not merged into the append.
	const records = parsedRecords(file);
	assert.deepEqual(
		records.map((record) => record.id),
		["resume", "entry-1", "entry-2", appendedId],
	);
	assert.equal(records.filter((record) => record.id === "entry-2").length, 1);
	assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "appends must stay newline terminated");

	// A fresh resume observes the appended record exactly once, in order.
	const resumed = SessionManager.open(file, dir);
	assert.deepEqual(
		list(resumed.getEntries()).map((entry) => entry.id),
		["entry-1", "entry-2", appendedId],
	);
}

/**
 * A batch is transferred one source at a time. The first transfer collides with an existing
 * destination, which must leave both files byte-identical and must not stop later transfers;
 * the last source ends with an unterminated record that must survive the transfer.
 */
async function testBatchTransferWithCollision(modules) {
	const { SessionManager } = modules.sessionManager;
	const base = path.join(tmp, "batch");
	const sources = path.join(base, "sources");
	const destination = path.join(base, "destination");
	const batchCwd = path.join(base, "project");
	for (const dir of [sources, destination, batchCwd]) fs.mkdirSync(dir, { recursive: true });

	// Source 1: collides with an existing destination session of the same id and timestamp.
	const collisionSource = path.join(sources, "collision.jsonl");
	const collisionContent = `${headerLine("collision", batchCwd, 3)}\n${messageLine("collision-1", "kept", null)}\n`;
	fs.writeFileSync(collisionSource, collisionContent);

	// Source 2: valid session whose last JSONL record has no newline.
	const tailSource = path.join(sources, "tail.jsonl");
	const tailContent =
		`${headerLine("tail-batch", batchCwd, 3)}\n` +
		`${messageLine("tail-1", "first", null)}\n` +
		`${messageLine("tail-2", "last", "tail-1")}`;
	fs.writeFileSync(tailSource, tailContent);

	const transfers = [
		{ id: "collision", source: collisionSource, collides: true },
		{ id: "tail-batch", source: tailSource, collides: false },
	];

	// Pre-create the exact destination file the first transfer targets, forcing a collision.
	const collisionTimestamp = new Date(clock.now).toISOString().replace(/[:.]/g, "-");
	const collisionDestination = path.join(destination, `${collisionTimestamp}_collision.jsonl`);
	const collisionDestinationContent = `${headerLine("collision", batchCwd, 3)}\n${messageLine("stored-1", "existing", null)}\n`;
	fs.writeFileSync(collisionDestination, collisionDestinationContent);

	const outcomes = [];
	for (const transfer of transfers) {
		try {
			const forked = SessionManager.forkFrom(transfer.source, batchCwd, destination, { id: transfer.id });
			outcomes.push({ id: transfer.id, ok: true, sessionFile: forked.getSessionFile(), forked });
		} catch (error) {
			outcomes.push({ id: transfer.id, ok: false, error });
		}
		clock.now += 1_000; // fixed step; no real time participates
	}

	// The collision is reported rather than overwriting, and it did not stop later transfers.
	assert.equal(outcomes[0].ok, false, "a colliding transfer must fail instead of overwriting");
	assert.match(String(outcomes[0].error && outcomes[0].error.message), /EEXIST|exist/i);
	assert.equal(outcomes[1].ok, true, "later transfers must still run after a collision");

	// Colliding source and destination bytes are untouched.
	assert.equal(fs.readFileSync(collisionSource, "utf8"), collisionContent);
	assert.equal(fs.readFileSync(collisionDestination, "utf8"), collisionDestinationContent);

	// The colliding destination is not reused by the later transfer.
	assert.notEqual(outcomes[1].sessionFile, collisionDestination);
	assert.equal(list(outcomes[1].forked.getEntries()).length, 2);

	// The tail transfer keeps the unterminated final record exactly once and terminates the file.
	assert.equal(
		fs.readFileSync(tailSource, "utf8"),
		`${tailContent}\n`,
		"reading the source repairs exactly one missing newline",
	);
	const tailDestination = outcomes[1].sessionFile;
	const tailRecords = parsedRecords(tailDestination);
	assert.deepEqual(
		tailRecords.map((record) => record.id),
		["tail-batch", "tail-1", "tail-2"],
		"the transferred session must retain its final record exactly once",
	);
	assert.ok(fs.readFileSync(tailDestination, "utf8").endsWith("\n"));

	// Re-reading the resulting file across the module boundary is idempotent.
	const before = fs.readFileSync(tailDestination, "utf8");
	const reopened = SessionManager.open(tailDestination, destination);
	assert.deepEqual(
		list(reopened.getEntries()).map((entry) => entry.id),
		["tail-1", "tail-2"],
	);
	assert.equal(fs.readFileSync(tailDestination, "utf8"), before);
}

/**
 * The mixed legacy half of the batch: files without ids are migrated when they are opened, and a
 * colliding id generator result must not stop later entries from migrating.
 */
async function testLegacyBatchMigration(modules, migrateSessionEntries) {
	const { SessionManager } = modules.sessionManager;
	const dir = path.join(tmp, "legacy-batch");
	fs.mkdirSync(dir, { recursive: true });

	const payloads = ["legacy hé漢字", "legacy 🙂 end"];
	const file = path.join(dir, "legacy.jsonl");
	const malformed = "oops not json";
	const content =
		`${headerLine("legacy", dir)}\n` +
		`${malformed}\n` +
		JSON.stringify({ type: "message", timestamp: HEADER_TS, message: { role: "user", content: payloads[0], timestamp: CLOCK_START } }) +
		"\n" +
		JSON.stringify({ type: "message", timestamp: HEADER_TS, message: { role: "user", content: payloads[1], timestamp: CLOCK_START } });
	fs.writeFileSync(file, content);

	randomUuids = [
		"aaaaaaaa-0000-4000-8000-000000000001",
		"aaaaaaaa-0000-4000-8000-000000000002",
		"bbbbbbbb-0000-4000-8000-000000000003",
	];
	const session = SessionManager.open(file, dir);
	const migrated = list(session.getEntries());
	assert.equal(migrated.length, 2, "malformed lines are skipped and valid records are kept");
	assert.deepEqual(migrated.map((entry) => plain(entry.message.content)), payloads);
	assert.equal(session.getHeader().version, 3);
	assert.equal(new Set(migrated.map((entry) => entry.id)).size, migrated.length, "colliding ids must be retried");
	assert.deepEqual(
		migrated.map((entry) => entry.parentId),
		[null, migrated[0].id],
		"later entries must still migrate after a collision",
	);
	for (const entry of migrated) assert.equal(entry.id.length, 8);

	// The migrated file keeps every record exactly once and is newline terminated.
	const records = parsedRecords(file);
	assert.equal(records.filter((record) => record.type === "session").length, 1);
	assert.deepEqual(records.slice(1).map((record) => record.id), migrated.map((entry) => entry.id));
	assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
	randomUuids = [];

	// The exported migration helper is the same production path.
	const entries = [
		{ type: "session", id: "colliding", timestamp: HEADER_TS, cwd: dir },
		{ type: "message", timestamp: HEADER_TS, message: { role: "user", content: "one", timestamp: CLOCK_START } },
		{ type: "message", timestamp: HEADER_TS, message: { role: "user", content: "two", timestamp: CLOCK_START } },
	];
	randomUuids = [
		"aaaaaaaa-0000-4000-8000-000000000001",
		"aaaaaaaa-0000-4000-8000-000000000002",
		"cccccccc-0000-4000-8000-000000000003",
	];
	migrateSessionEntries(entries);
	assert.equal(entries[0].version, 3);
	assert.equal(new Set(entries.slice(1).map((entry) => entry.id)).size, 2);
	assert.deepEqual(
		entries.slice(1).map((entry) => entry.parentId),
		[null, entries[1].id],
	);
	randomUuids = [];
}

try {
	await main();
	console.log("regression: ok");
} finally {
	removeTree(tmp);
}
