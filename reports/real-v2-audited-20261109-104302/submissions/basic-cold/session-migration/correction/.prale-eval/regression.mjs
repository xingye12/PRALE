/**
 * Regression for the session migration collision policy.
 *
 * Policy under test: an existing destination always wins. Both the destination
 * bytes and the colliding legacy source must stay untouched, unrelated legacy
 * files must still be migrated, and neither copy may ever be overwritten or
 * deleted.
 *
 * The real production module (packages/coding-agent/src/migrations.ts) is loaded
 * through .prale-eval/subject.mjs: real fs, real path, only getAgentDir/stripBom
 * are faked. No npm install, no network.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpBase = path.join(root, ".prale-eval", ".tmp-regression");
const scratch = mkdtempSync(path.join(ensureDir(tmpBase), "agent-"));

function ensureDir(dir) {
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Session file body: first line is the header the migration parses. */
function sessionFile(cwd, tag) {
	return `${JSON.stringify({ type: "session", version: 1, id: `id-${tag}`, cwd })}\n${JSON.stringify({
		type: "message",
		tag,
	})}\n`;
}

/** Same directory encoding the migration uses for sessions/<encoded-cwd>/. */
function sessionDir(agentDir, cwd) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(agentDir, "sessions", safePath);
}

try {
	const agentDir = scratch;
	const collisionCwd = "/work/collide";
	const unrelatedCwd = "/work/unrelated";

	// --- Fixture: a real collision plus an unrelated file in the same run ---
	const legacyCollision = sessionFile(collisionCwd, "legacy");
	const destinationBytes = `${JSON.stringify({ type: "session", version: 1, id: "already-migrated", cwd: collisionCwd })}\n{"type":"message","tag":"destination"}\n`;
	const legacyUnrelated = sessionFile(unrelatedCwd, "unrelated");

	const collisionSourcePath = path.join(agentDir, "collide.jsonl");
	const collisionDestDir = ensureDir(sessionDir(agentDir, collisionCwd));
	const collisionDestPath = path.join(collisionDestDir, "collide.jsonl");
	const unrelatedSourcePath = path.join(agentDir, "unrelated.jsonl");

	writeFileSync(collisionSourcePath, legacyCollision);
	writeFileSync(collisionDestPath, destinationBytes);
	writeFileSync(unrelatedSourcePath, legacyUnrelated);

	const migrations = await loadMigrations(root, agentDir);
	assert.equal(
		typeof migrations.migrateSessionsFromAgentRoot,
		"function",
		"production module must export migrateSessionsFromAgentRoot",
	);

	migrations.migrateSessionsFromAgentRoot();

	// 1. Existing destination wins: its bytes are exactly preserved.
	assert.equal(
		readFileSync(collisionDestPath, "utf8"),
		destinationBytes,
		"existing destination session must win and keep its exact bytes",
	);

	// 2. The colliding legacy source is left in place, untouched.
	assert.ok(
		existsSync(collisionSourcePath),
		"colliding legacy session must not be deleted from the agent root",
	);
	assert.equal(
		readFileSync(collisionSourcePath, "utf8"),
		legacyCollision,
		"colliding legacy session bytes must be left untouched",
	);

	// 3. No extra copies / renamed leftovers were produced in the destination dir.
	assert.deepEqual(
		readdirSync(collisionDestDir).sort(),
		["collide.jsonl"],
		"collision handling must not create or delete other files in the destination directory",
	);

	// 4. Unrelated files still migrate in the same invocation.
	assert.ok(
		!existsSync(unrelatedSourcePath),
		"unrelated legacy session must still be migrated out of the agent root",
	);
	const unrelatedDestPath = path.join(sessionDir(agentDir, unrelatedCwd), "unrelated.jsonl");
	assert.ok(existsSync(unrelatedDestPath), "unrelated legacy session must arrive at its encoded session directory");
	assert.equal(
		readFileSync(unrelatedDestPath, "utf8"),
		legacyUnrelated,
		"unrelated migration must preserve the session bytes",
	);

	// 5. Idempotent: a second run is also collision-safe and still migrates nothing away.
	migrations.migrateSessionsFromAgentRoot();
	assert.equal(readFileSync(collisionDestPath, "utf8"), destinationBytes, "second run must not overwrite destination");
	assert.equal(readFileSync(collisionSourcePath, "utf8"), legacyCollision, "second run must not delete legacy source");
	assert.equal(readFileSync(unrelatedDestPath, "utf8"), legacyUnrelated, "second run must not disturb migrated copy");

	// 6. A fresh, non-colliding session still migrates (policy is not a blanket no-op).
	const freshCwd = "/work/fresh";
	const freshBytes = sessionFile(freshCwd, "fresh");
	const freshSourcePath = path.join(agentDir, "fresh.jsonl");
	writeFileSync(freshSourcePath, freshBytes);
	migrations.migrateSessionsFromAgentRoot();
	assert.ok(!existsSync(freshSourcePath), "non-colliding session must still migrate");
	assert.equal(
		readFileSync(path.join(sessionDir(agentDir, freshCwd), "fresh.jsonl"), "utf8"),
		freshBytes,
		"non-colliding migration must preserve session bytes",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
	rmSync(tmpBase, { recursive: true, force: true });
}

console.log("regression: existing destination wins; legacy source and destination preserved; unrelated files migrate");
