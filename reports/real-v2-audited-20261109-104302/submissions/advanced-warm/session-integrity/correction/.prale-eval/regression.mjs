/**
 * Regression coverage for the clarified data-safety policy:
 *
 *  1. `migrations.ts` — a session migration must never overwrite an existing
 *     destination file. Existing destination bytes win, both sides of a
 *     collision survive, and unrelated session files keep migrating.
 *  2. `core/session-manager.ts` — the session reader must reject a first entry
 *     that is not a session header with a string ID *before* repairing a
 *     missing final newline, so invalid files are never rewritten. Valid
 *     headers stay readable and valid unterminated final records are repaired.
 *
 * Both production modules are loaded through `.prale-eval/subject.mjs`, which
 * links the real submitted sources (migration -> real text helpers -> real
 * session reader) and fakes only external boundaries. Assertions are uncaught
 * `node:assert/strict` failures; no real time, randomness or network is used.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sandbox = path.join(workspaceRoot, ".prale-eval", "tmp-session-integrity");
const agentDir = path.join(sandbox, "agent");

// Deterministic fixtures: fixed timestamps and IDs, no clocks or randomness.
const HEADER_TS = "2025-01-01T00:00:00.000Z";
const MESSAGE_TS = "2025-01-01T00:00:01.000Z";

function cleanup() {
	fs.rmSync(sandbox, { recursive: true, force: true });
}

/** Always clean local test inputs, including when an assertion throws. */
process.on("exit", () => {
	try {
		cleanup();
	} catch {
		// Best effort: the sandbox lives inside the workspace and is disposable.
	}
});

function resetSandbox() {
	cleanup();
	fs.mkdirSync(agentDir, { recursive: true });
}

/** Mirror of the session-directory encoding shared by migration and reader. */
function sessionDirFor(agentRoot, cwd) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(agentRoot, "sessions", safePath);
}

function header(overrides) {
	return { type: "session", version: 3, timestamp: HEADER_TS, ...overrides };
}

function messageEntry(overrides = {}) {
	return {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: MESSAGE_TS,
		message: { role: "user", content: "hi", timestamp: 1 },
		...overrides,
	};
}

function readBytes(file) {
	return fs.readFileSync(file, "utf8");
}

function writeBytes(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function report(name) {
	console.log(`ok - ${name}`);
}

const { migration, session } = await createSessionPipeline(workspaceRoot, agentDir);

// ---------------------------------------------------------------------------
// 1. Migration collision safety: existing destination bytes win, both sides
//    survive, and other migrations continue.
// ---------------------------------------------------------------------------
resetSandbox();

const collisionCwd = path.join(sandbox, "projects", "alpha");
const siblingCwd = path.join(sandbox, "projects", "beta");
const invalidCwd = path.join(sandbox, "projects", "gamma");

const collisionDestDir = sessionDirFor(agentDir, collisionCwd);
const collisionDest = path.join(collisionDestDir, "collide.jsonl");
// Pre-existing destination bytes (different session) that must never change.
const destinationBytes = `${JSON.stringify(header({ id: "destination-session", cwd: collisionCwd }))}\n${JSON.stringify(
	messageEntry({ id: "dest-message" }),
)}\n`;
writeBytes(collisionDest, destinationBytes);

const collisionSource = path.join(agentDir, "collide.jsonl");
const collisionSourceBytes = `${JSON.stringify(header({ id: "source-session", cwd: collisionCwd }))}\n`;
writeBytes(collisionSource, collisionSourceBytes);

const siblingSource = path.join(agentDir, "sibling.jsonl");
const siblingSourceBytes = `${JSON.stringify(header({ id: "sibling-session", cwd: siblingCwd }))}\n`;
writeBytes(siblingSource, siblingSourceBytes);
const siblingDest = path.join(sessionDirFor(agentDir, siblingCwd), "sibling.jsonl");

// A header that the migration still relocates but the reader must reject: it
// has the header shape but no string ID, and no terminating newline.
const invalidSource = path.join(agentDir, "no-id.jsonl");
const invalidHeaderBytes = JSON.stringify({ type: "session", version: 3, cwd: invalidCwd });
writeBytes(invalidSource, invalidHeaderBytes);
const invalidDest = path.join(sessionDirFor(agentDir, invalidCwd), "no-id.jsonl");

migration.migrateSessionsFromAgentRoot();

assert.equal(readBytes(collisionDest), destinationBytes, "existing destination bytes must win a collision");
assert.equal(fs.existsSync(collisionSource), true, "the colliding source file must survive the migration");
assert.equal(readBytes(collisionSource), collisionSourceBytes, "the colliding source bytes must be preserved");
assert.equal(fs.existsSync(siblingSource), false, "a non-colliding session must still be migrated");
assert.equal(fs.existsSync(siblingDest), true, "a non-colliding session must reach its session directory");
assert.equal(readBytes(siblingDest), siblingSourceBytes, "a migrated session must keep its bytes");
report("migration preserves both sides of a collision and continues other migrations");

// Cross-module consumer check: the migrated artifact is readable by the real
// session reader opened through SessionManager.
const migrated = session.SessionManager.open(siblingDest);
assert.equal(migrated.getSessionId(), "sibling-session", "the reader must accept the migrated header ID");
assert.equal(migrated.getCwd(), siblingCwd, "the reader must adopt the migrated header cwd");
assert.equal(readBytes(siblingDest), siblingSourceBytes, "opening a current-version session must not rewrite it");
const migratedEntries = session.loadEntriesFromFile(siblingDest);
assert.equal(migratedEntries.length, 1);
assert.equal(migratedEntries[0].id, "sibling-session");
report("the real session reader accepts the migrated session header");

// The preserved destination remains the readable session on the consumer side.
const preserved = session.SessionManager.open(collisionDest);
assert.equal(preserved.getSessionId(), "destination-session");
assert.equal(readBytes(collisionDest), destinationBytes, "the surviving destination must stay byte-identical");
report("the preserved destination is the session the reader sees");

// Cross-module rejection: the relocated ID-less header is rejected by the
// reader without any newline repair, even though it is unterminated.
assert.equal(fs.existsSync(invalidDest), true, "the migration moved the header-shaped file");
const rejectedRelocated = session.loadEntriesFromFile(invalidDest);
assert.equal(rejectedRelocated.length, 0, "the reader must reject a header lacking a string ID");
assert.equal(readBytes(invalidDest), invalidHeaderBytes, "rejecting an invalid header must not rewrite its file");
assert.throws(
	() => session.SessionManager.open(invalidDest),
	"opening a file without a valid session header must fail rather than adopt it",
);
assert.equal(readBytes(invalidDest), invalidHeaderBytes, "a failed open must leave the invalid file untouched");
report("the reader rejects a migrated invalid header without rewriting it");

// Re-running the migration is deterministic: the collision is still intact,
// the source still untouched, and nothing new is produced.
migration.migrateSessionsFromAgentRoot();
assert.equal(readBytes(collisionDest), destinationBytes, "a repeated migration must not overwrite the destination");
assert.equal(fs.existsSync(collisionSource), true, "a repeated migration must not consume the colliding source");
assert.equal(readBytes(collisionSource), collisionSourceBytes);
report("repeated migration keeps the collision intact");

// ---------------------------------------------------------------------------
// 2. Reader: invalid headers are rejected without rewriting their files.
// ---------------------------------------------------------------------------
resetSandbox();

const invalidCases = [
	{
		name: "header-shaped entry without an ID",
		content: JSON.stringify({ type: "session", version: 3, cwd: "/tmp/project" }),
	},
	{
		name: "header-shaped entry without an ID and with a terminator",
		content: `${JSON.stringify({ type: "session", version: 3, cwd: "/tmp/project" })}\n`,
	},
	{
		name: "header with a non-string ID",
		content: JSON.stringify(header({ id: 7, cwd: "/tmp/project" })),
	},
	{
		name: "non-session first entry with a string ID",
		content: JSON.stringify(messageEntry()),
	},
];

for (const { name, content } of invalidCases) {
	const file = path.join(sandbox, "invalid", `${name.replace(/\W+/g, "-")}.jsonl`);
	writeBytes(file, content);
	const rejected = session.loadEntriesFromFile(file);
	// Cross-realm arrays come from the module graph's vm context, so compare length.
	assert.equal(rejected.length, 0, `the reader must reject ${name}`);
	assert.equal(readBytes(file), content, `rejecting ${name} must not rewrite the file`);
}
report("invalid headers are rejected without newline repair or rewriting");

// ---------------------------------------------------------------------------
// 3. Reader: valid headers are accepted and valid unterminated final records
//    are still repaired, idempotently.
// ---------------------------------------------------------------------------
resetSandbox();

const validFile = path.join(sandbox, "valid", "unterminated.jsonl");
const validHeaderLine = JSON.stringify(header({ id: "valid-session", cwd: "/tmp/project" }));
const validContent = `${validHeaderLine}\n${JSON.stringify(messageEntry())}`;
writeBytes(validFile, validContent);

const validEntries = session.loadEntriesFromFile(validFile);
assert.equal(validEntries.length, 2, "a valid session with an unterminated final record must load");
assert.equal(validEntries[0].id, "valid-session", "the accepted header ID must be returned");
assert.equal(readBytes(validFile), `${validContent}\n`, "a valid unterminated final record must gain one newline");

// A second read is stable: the repair happened once and nothing else changes.
assert.equal(session.loadEntriesFromFile(validFile).length, 2);
assert.equal(readBytes(validFile), `${validContent}\n`, "repairing a valid unterminated record must be idempotent");
report("valid unterminated records are repaired exactly once");

const unterminatedHeaderFile = path.join(sandbox, "valid", "header-only.jsonl");
writeBytes(unterminatedHeaderFile, validHeaderLine);
const headerOnly = session.loadEntriesFromFile(unterminatedHeaderFile);
assert.equal(headerOnly.length, 1);
assert.equal(headerOnly[0].id, "valid-session");
assert.equal(readBytes(unterminatedHeaderFile), `${validHeaderLine}\n`, "a valid unterminated header must be repaired");
report("a valid unterminated header is accepted and repaired");

const terminatedFile = path.join(sandbox, "valid", "terminated.jsonl");
const terminatedContent = `${validHeaderLine}\n${JSON.stringify(messageEntry())}\n`;
writeBytes(terminatedFile, terminatedContent);
assert.equal(session.loadEntriesFromFile(terminatedFile).length, 2);
assert.equal(readBytes(terminatedFile), terminatedContent, "a terminated valid session must not be rewritten");
report("a terminated valid session is read without rewriting");

const malformedTailFile = path.join(sandbox, "valid", "malformed-tail.jsonl");
const malformedTailContent = `${validHeaderLine}\n{"type":"message"`;
writeBytes(malformedTailFile, malformedTailContent);
const malformedTailEntries = session.loadEntriesFromFile(malformedTailFile);
assert.equal(malformedTailEntries.length, 1, "a valid header must survive a malformed final fragment");
assert.equal(readBytes(malformedTailFile), `${malformedTailContent}\n`, "an unterminated tail must still be repaired");
report("an unterminated malformed tail after a valid header is still repaired");

// Cross-module handoff: the migration relocates a valid session whose final
// record is unterminated, and the reader both accepts it and repairs exactly
// one newline. This is the producer -> consumer flow the policy must agree on.
const unterminatedCwd = path.join(sandbox, "projects", "delta");
const unterminatedSource = path.join(agentDir, "unterminated.jsonl");
const unterminatedHeaderLine = JSON.stringify(header({ id: "unterminated-session", cwd: unterminatedCwd }));
const unterminatedSourceBytes = `${unterminatedHeaderLine}\n${JSON.stringify(messageEntry())}`;
writeBytes(unterminatedSource, unterminatedSourceBytes);
const unterminatedDest = path.join(sessionDirFor(agentDir, unterminatedCwd), "unterminated.jsonl");

migration.migrateSessionsFromAgentRoot();

assert.equal(fs.existsSync(unterminatedSource), false, "the unterminated session must migrate");
assert.equal(readBytes(unterminatedDest), unterminatedSourceBytes, "migration must move bytes without rewriting them");
const repairedEntries = session.loadEntriesFromFile(unterminatedDest);
assert.equal(repairedEntries.length, 2, "the reader must accept the migrated header and its final record");
assert.equal(repairedEntries[0].id, "unterminated-session");
assert.equal(readBytes(unterminatedDest), `${unterminatedSourceBytes}\n`, "the reader must repair the migrated record once");
report("a migrated unterminated session is repaired by the reader");

cleanup();
console.log("regression: session integrity behaviors verified");
