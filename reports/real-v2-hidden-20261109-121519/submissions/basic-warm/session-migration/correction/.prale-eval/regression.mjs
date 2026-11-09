/**
 * Regression for session-migration/correction.
 *
 * Collision policy under test: when the destination session file already exists,
 * it always wins. Both the existing destination bytes and the colliding legacy
 * ~/.pi/agent/*.jsonl source must be left untouched, and migration must continue
 * with the unrelated files.
 *
 * Runs the real `migrateSessionsFromAgentRoot` from packages/coding-agent/src/migrations.ts
 * through the .prale-eval/subject.mjs loader (real fs/path, caller-owned temp agentDir).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same encoding as session-manager.ts / migrations.ts. */
function sessionDirName(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionBody(cwd, marker) {
	const header = JSON.stringify({ type: "session", version: 1, cwd, id: `id-${marker}` });
	return `${header}\n${JSON.stringify({ type: "message", role: "user", content: marker })}\n`;
}

function makeAgentDir(parent) {
	const agentDir = mkdtempSync(path.join(parent, "tmp-migration-"));
	return agentDir;
}

async function runMigration(agentDir) {
	const migrations = await loadMigrations(root, agentDir);
	migrations.migrateSessionsFromAgentRoot();
}

const failures = [];

async function scenario(name, fn) {
	const workRoot = path.join(root, ".prale-eval");
	const agentDir = makeAgentDir(workRoot);
	try {
		await fn(agentDir);
	} catch (error) {
		error.message = `${name}: ${error.message}`;
		failures.push(error);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

// 1. Existing destination wins: destination bytes stay intact, the colliding
//    legacy source survives, and the unrelated legacy file still migrates.
await scenario("existing destination must win and both copies must survive", async (agentDir) => {
	const cwd = "/home/dev/collide";
	const legacyName = "2025-01-01T00-00-00-000Z_session.jsonl";
	const legacyPath = path.join(agentDir, legacyName);
	const destinationPath = path.join(agentDir, "sessions", sessionDirName(cwd), legacyName);

	const legacyContent = sessionBody(cwd, "legacy-source-bytes");
	const destinationContent = sessionBody(cwd, "destination-wins-bytes");

	mkdirSync(path.dirname(destinationPath), { recursive: true });
	writeFileSync(legacyPath, legacyContent, "utf8");
	writeFileSync(destinationPath, destinationContent, "utf8");

	// Unrelated legacy session that must still migrate in the same pass.
	const otherCwd = "/home/dev/unrelated";
	const otherName = "2025-02-02T00-00-00-000Z_other.jsonl";
	const otherLegacyPath = path.join(agentDir, otherName);
	const otherDestinationPath = path.join(agentDir, "sessions", sessionDirName(otherCwd), otherName);
	const otherContent = sessionBody(otherCwd, "unrelated-bytes");
	writeFileSync(otherLegacyPath, otherContent, "utf8");

	await runMigration(agentDir);

	assert.ok(existsSync(destinationPath), "existing destination file must still exist after migration");
	assert.equal(
		readFileSync(destinationPath, "utf8"),
		destinationContent,
		"existing destination must always win: its bytes must never be overwritten",
	);
	assert.ok(existsSync(legacyPath), "colliding legacy source must not be deleted by migration");
	assert.equal(
		readFileSync(legacyPath, "utf8"),
		legacyContent,
		"colliding legacy source bytes must be left untouched",
	);

	assert.ok(existsSync(otherDestinationPath), "unrelated legacy session must still be migrated");
	assert.equal(readFileSync(otherDestinationPath, "utf8"), otherContent, "migrated session bytes must be preserved");
	assert.ok(!existsSync(otherLegacyPath), "successfully migrated legacy source must be moved, not copied");
});

// 2. Collision handling is stable: a second pass changes nothing in either copy.
await scenario("collision policy is idempotent", async (agentDir) => {
	const cwd = "C:\\Users\\dev\\project";
	const legacyName = "2025-03-03T00-00-00-000Z_repeat.jsonl";
	const legacyPath = path.join(agentDir, legacyName);
	const destinationPath = path.join(agentDir, "sessions", sessionDirName(cwd), legacyName);
	const legacyContent = sessionBody(cwd, "legacy-repeat");
	const destinationContent = sessionBody(cwd, "destination-repeat");

	mkdirSync(path.dirname(destinationPath), { recursive: true });
	writeFileSync(legacyPath, legacyContent, "utf8");
	writeFileSync(destinationPath, destinationContent, "utf8");

	await runMigration(agentDir);
	await runMigration(agentDir);

	assert.equal(readFileSync(destinationPath, "utf8"), destinationContent, "destination bytes must stay stable");
	assert.equal(readFileSync(legacyPath, "utf8"), legacyContent, "legacy source bytes must stay stable");
});

// 3. Unrelated files in the same session folder (with other cwd encodings) are
//    still migrated once a collision was skipped.
await scenario("a skipped collision does not abort later migrations", async (agentDir) => {
	const collisionCwd = "/srv/app";
	const collisionName = "2025-04-04T00-00-00-000Z_skip.jsonl";
	const collisionLegacy = path.join(agentDir, collisionName);
	const collisionDestination = path.join(agentDir, "sessions", sessionDirName(collisionCwd), collisionName);
	const destinationContent = sessionBody(collisionCwd, "keep-me");

	mkdirSync(path.dirname(collisionDestination), { recursive: true });
	writeFileSync(collisionLegacy, sessionBody(collisionCwd, "loser"), "utf8");
	writeFileSync(collisionDestination, destinationContent, "utf8");

	const migrated = [];
	for (const marker of ["alpha", "beta"]) {
		const cwd = `/srv/app-${marker}`;
		const name = `2025-05-0${marker === "alpha" ? 1 : 2}T00-00-00-000Z_${marker}.jsonl`;
		writeFileSync(path.join(agentDir, name), sessionBody(cwd, `${marker}-bytes`), "utf8");
		migrated.push([name, path.join(agentDir, "sessions", sessionDirName(cwd), name), `${marker}-bytes`]);
	}

	await runMigration(agentDir);

	assert.equal(readFileSync(collisionDestination, "utf8"), destinationContent, "collision destination must win");
	assert.ok(existsSync(collisionLegacy), "collision legacy source must survive");

	for (const [name, destination, marker] of migrated) {
		assert.ok(existsSync(destination), `unrelated session ${name} must be migrated after a skipped collision`);
		assert.ok(readFileSync(destination, "utf8").includes(marker), `migrated session ${name} lost its content`);
		assert.ok(!existsSync(path.join(agentDir, name)), `migrated session ${name} must not remain in agent root`);
	}
});

// 4. Non-colliding legacy sessions still migrate normally (baseline behavior).
await scenario("non-colliding legacy sessions still migrate", async (agentDir) => {
	const cwd = "/srv/clean";
	const name = "2025-06-06T00-00-00-000Z_clean.jsonl";
	const legacyPath = path.join(agentDir, name);
	const destinationPath = path.join(agentDir, "sessions", sessionDirName(cwd), name);
	const content = sessionBody(cwd, "clean-bytes");
	writeFileSync(legacyPath, content, "utf8");

	await runMigration(agentDir);

	assert.ok(existsSync(destinationPath), "clean legacy session must be migrated into its session directory");
	assert.equal(readFileSync(destinationPath, "utf8"), content, "migrated bytes must be preserved exactly");
	assert.ok(!existsSync(legacyPath), "clean legacy session must be removed from the agent root");
});

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure.message}`);
	const [first] = failures;
	throw first;
}

console.log("regression: session migration collision policy preserves both copies and continues migrating");
