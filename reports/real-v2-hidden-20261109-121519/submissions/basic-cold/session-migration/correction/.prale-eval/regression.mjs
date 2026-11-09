/**
 * Regression for session-migration/correction.
 *
 * Policy: when migrating legacy sessions from the agent root into
 * sessions/<encoded-cwd>/, an existing destination always wins. Both the
 * destination bytes and the colliding legacy source must be left untouched,
 * while unrelated files must still be migrated.
 *
 * Exercises the real migrateSessionsFromAgentRoot production code through the
 * read-only subject helper (real fs/path, fake getAgentDir/stripBom).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMigrations } from "./subject.mjs";

const root = process.cwd();
const scratch = mkdtempSync(join(root, ".prale-eval", "regression-tmp-"));
const agentDir = join(scratch, "agent");

const header = (cwd, id) => JSON.stringify({ type: "session", id, cwd });

// Colliding pair: same file name in the legacy root and in the correct folder.
const collisionCwd = "/work/project";
const collisionDir = join(agentDir, "sessions", "--work-project--");
const collisionName = "collision.jsonl";
const legacyCollisionPath = join(agentDir, collisionName);
const destinationPath = join(collisionDir, collisionName);
const legacyBytes = `${header(collisionCwd, "legacy-copy")}\nlegacy-body\n`;
const destinationBytes = `${header(collisionCwd, "existing-destination")}\nexisting-body\n`;

// An unrelated legacy session that must still be migrated normally.
const freeCwd = "/work/other";
const freeDir = join(agentDir, "sessions", "--work-other--");
const freeName = "unrelated.jsonl";
const legacyFreePath = join(agentDir, freeName);
const freeBytes = `${header(freeCwd, "unrelated")}\nfree-body\n`;
const freeDestinationPath = join(freeDir, freeName);

function snapshot(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

try {
	mkdirSync(collisionDir, { recursive: true });
	writeFileSync(destinationPath, destinationBytes);
	writeFileSync(legacyCollisionPath, legacyBytes);
	writeFileSync(legacyFreePath, freeBytes);

	const migrations = await loadMigrations(root, agentDir);
	assert.equal(typeof migrations.migrateSessionsFromAgentRoot, "function");
	migrations.migrateSessionsFromAgentRoot();

	// 1. The existing destination wins byte-for-byte (never overwritten).
	assert.equal(
		snapshot(destinationPath),
		destinationBytes,
		"existing destination must not be overwritten by the collision policy",
	);

	// 2. The colliding legacy source is neither renamed away nor deleted.
	assert.equal(
		snapshot(legacyCollisionPath),
		legacyBytes,
		"colliding legacy source must be left untouched at its original path",
	);

	// 3. Unrelated files still migrate: moved to the correct folder, source gone.
	assert.equal(
		snapshot(freeDestinationPath),
		freeBytes,
		"unrelated legacy session must still be migrated to sessions/<encoded-cwd>/",
	);
	assert.equal(
		existsSync(legacyFreePath),
		false,
		"unrelated legacy session should no longer remain in the agent root after migration",
	);

	// 4. A second run is idempotent: nothing changes for the collision pair.
	migrations.migrateSessionsFromAgentRoot();
	assert.equal(snapshot(destinationPath), destinationBytes, "destination stable across reruns");
	assert.equal(snapshot(legacyCollisionPath), legacyBytes, "legacy collision source stable across reruns");

	console.log("session-migration/correction regression: ok");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
