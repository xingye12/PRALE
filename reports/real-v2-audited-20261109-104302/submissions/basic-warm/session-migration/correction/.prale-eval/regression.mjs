/**
 * Standalone regression for the legacy session migration collision policy.
 *
 * Invariant under test (drive the real production code, no re-implementation):
 *   When `migrateSessionsFromAgentRoot()` finds a legacy `*.jsonl` session whose
 *   destination already exists, the existing destination must win: both the
 *   destination bytes and the legacy source bytes stay untouched, and the
 *   migration keeps moving unrelated sessions.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMigrations } from "./subject.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Same directory encoding as session-manager.ts / migrations.ts. */
function sessionDirFor(agentDir, cwd) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safePath);
}

function sessionBody(cwd, marker) {
	return `${JSON.stringify({ type: "session", version: 3, cwd })}\n${JSON.stringify({ role: "user", marker })}\n`;
}

/** Host-realm, order-stable listing so sorting/array assertions are realm-safe. */
function listing(dir) {
	return Array.from(readdirSync(dir), (entry) => String(entry)).sort();
}

const COLLIDE_CWD = "/work/alpha";
const MOVE_CWD = "/work/beta";

const CHECKED = [];
function check(name, fn) {
	fn();
	CHECKED.push(name);
}

const tmpRoot = mkdtempSync(join(root, ".prale-eval", "tmp-collision-"));
try {
	const agentDir = join(tmpRoot, "agent");
	mkdirSync(agentDir, { recursive: true });

	// --- fixture: one colliding session and one unrelated session -----------
	const legacyCollision = join(agentDir, "collision.jsonl");
	const collisionSourceBytes = sessionBody(COLLIDE_CWD, "legacy-source-copy");
	writeFileSync(legacyCollision, collisionSourceBytes);

	const collideDir = sessionDirFor(agentDir, COLLIDE_CWD);
	mkdirSync(collideDir, { recursive: true });
	const collideDest = join(collideDir, "collision.jsonl");
	const destinationBytes = sessionBody(COLLIDE_CWD, "already-migrated-destination");
	writeFileSync(collideDest, destinationBytes);
	assert.notStrictEqual(collisionSourceBytes, destinationBytes, "fixture must have distinct colliding bytes");

	const legacyMove = join(agentDir, "keep-moving.jsonl");
	const moveBytes = sessionBody(MOVE_CWD, "unrelated-session");
	writeFileSync(legacyMove, moveBytes);

	// Non-session noise must be ignored by the migration filter.
	writeFileSync(join(agentDir, "notes.txt"), "not a session\n");

	const module = await loadMigrations(root, agentDir);
	assert.equal(typeof module.migrateSessionsFromAgentRoot, "function", "migrations module must export the migration");

	// --- drive the real production migration ---------------------------------
	module.migrateSessionsFromAgentRoot();

	check("existing destination bytes are never overwritten", () => {
		assert.equal(readFileSync(collideDest, "utf8"), destinationBytes);
	});

	check("colliding legacy source is left in place with its bytes intact", () => {
		assert.ok(existsSync(legacyCollision), "colliding legacy source must not be deleted");
		assert.equal(readFileSync(legacyCollision, "utf8"), collisionSourceBytes);
	});

	check("no replacement/duplicate artifact is created next to the collision", () => {
		assert.deepEqual(listing(collideDir), ["collision.jsonl"]);
	});

	check("unrelated legacy session still migrates to its session directory", () => {
		assert.equal(existsSync(legacyMove), false, "unrelated legacy source should have been moved");
		const moveDest = join(sessionDirFor(agentDir, MOVE_CWD), "keep-moving.jsonl");
		assert.ok(existsSync(moveDest), "unrelated session must land in its session directory");
		assert.equal(readFileSync(moveDest, "utf8"), moveBytes);
	});

	check("agent root keeps only the un-migratable collision plus the non-session file", () => {
		assert.deepEqual(listing(agentDir), ["collision.jsonl", "notes.txt", "sessions"]);
	});

	// --- idempotency: a second startup pass must still leave both copies -----
	module.migrateSessionsFromAgentRoot();

	check("repeated migration is stable: destination bytes unchanged", () => {
		assert.equal(readFileSync(collideDest, "utf8"), destinationBytes);
	});

	check("repeated migration is stable: legacy source bytes unchanged", () => {
		assert.ok(existsSync(legacyCollision), "colliding legacy source must survive repeated migration");
		assert.equal(readFileSync(legacyCollision, "utf8"), collisionSourceBytes);
	});

	check("repeated migration does not resurrect or duplicate the migrated session", () => {
		const moveDir = sessionDirFor(agentDir, MOVE_CWD);
		assert.deepEqual(listing(moveDir), ["keep-moving.jsonl"]);
	});

	assert.equal(CHECKED.length, 8, "all collision-policy assertions must run");
	console.log(`regression passed (${CHECKED.length} checks): ${CHECKED.join("; ")}`);
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}
