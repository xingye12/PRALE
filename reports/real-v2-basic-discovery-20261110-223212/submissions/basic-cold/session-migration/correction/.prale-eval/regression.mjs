/**
 * Regression for session-migration/correction.
 *
 * Policy under test: when migrating legacy sessions from the agent root into
 * `sessions/<encoded-cwd>/`, an existing destination always wins. The
 * destination bytes and the colliding legacy source must both be left
 * untouched, and unrelated legacy files must still migrate.
 *
 * Exercises the real `migrateSessionsFromAgentRoot` from
 * packages/coding-agent/src/migrations.ts (loaded through subject.mjs with
 * `getAgentDir` pointed at a temporary directory). Fails with an assertion on
 * the original fault, where the destination was overwritten via renameSync.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same cwd -> directory encoding as session-manager.ts / migrations.ts. */
function encodedCwd(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function writeSession(file, cwd, body) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ type: "session", cwd, id: path.basename(file, ".jsonl") })}\n${body}\n`);
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pi-session-migration-"));
const agentDir = path.join(tmpRoot, "agent");

const collidingCwd = "/home/dev/project-alpha";
const freeCwd = "/home/dev/project-beta";

const existingDestinationText = '{"type":"session","cwd":"/home/dev/project-alpha","origin":"already-migrated"}\ndestination-body\n';

const collidingName = "session-collision.jsonl";
const unrelatedName = "session-free.jsonl";

const legacyCollision = path.join(agentDir, collidingName);
const destination = path.join(agentDir, "sessions", encodedCwd(collidingCwd), collidingName);
const unrelatedSource = path.join(agentDir, unrelatedName);
const unrelatedDestination = path.join(agentDir, "sessions", encodedCwd(freeCwd), unrelatedName);

writeSession(legacyCollision, collidingCwd, "legacy-source-body");
writeSession(unrelatedSource, freeCwd, "unrelated-body");
// Pre-existing destination written verbatim so bytes can be compared 1:1.
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, existingDestinationText);

// Snapshots of the initial bytes; every later check compares against these.
const destinationBytes = readFileSync(destination);
const legacySourceBytes = readFileSync(legacyCollision);
const unrelatedBytes = readFileSync(unrelatedSource);
assert.ok(legacySourceBytes.length > 0 && destinationBytes.length > 0, "fixture: non-empty session files");

const migrations = await loadMigrations(root, agentDir);
assert.equal(
	typeof migrations.migrateSessionsFromAgentRoot,
	"function",
	"migrations.ts must export migrateSessionsFromAgentRoot",
);

migrations.migrateSessionsFromAgentRoot();

// 1. The existing destination wins: its bytes are byte-for-byte unchanged.
assert.deepEqual(
	readFileSync(destination),
	Buffer.from(destinationBytes, "utf8"),
	"existing destination must never be overwritten by a colliding legacy session",
);

// 2. The colliding legacy source is untouched (not moved, not deleted, same bytes).
assert.ok(existsSync(legacyCollision), "colliding legacy source must not be removed when the destination exists");
assert.deepEqual(
	readFileSync(legacyCollision),
	Buffer.from(legacySourceBytes, "utf8"),
	"colliding legacy source bytes must be left untouched",
);

// 3. Unrelated legacy sessions still migrate normally.
assert.ok(!existsSync(unrelatedSource), "non-colliding legacy session should be moved out of the agent root");
assert.deepEqual(
	readFileSync(unrelatedDestination),
	Buffer.from(unrelatedBytes, "utf8"),
	"non-colliding legacy session must arrive intact in its session directory",
);

// 4. Re-running the migration stays safe (idempotent collision handling).
migrations.migrateSessionsFromAgentRoot();
assert.deepEqual(
	readFileSync(destination),
	Buffer.from(destinationBytes, "utf8"),
	"destination must remain unchanged on repeated migration runs",
);
assert.deepEqual(
	readFileSync(legacyCollision),
	Buffer.from(legacySourceBytes, "utf8"),
	"colliding legacy source must remain unchanged on repeated migration runs",
);
assert.ok(existsSync(unrelatedDestination), "already-migrated unrelated session must stay in place");
assert.ok(!existsSync(unrelatedSource), "already-migrated session must not be duplicated into the agent root");

rmSync(tmpRoot, { recursive: true, force: true });
console.log("session migration collision regression: passed");
