/**
 * Regression for session-migration/retransfer.
 *
 * Loads the real packages/coding-agent/src/migrations.ts through the read-only
 * subject helper (real fs/path, caller-owned temp agentDir) and drives
 * migrateSessionsFromAgentRoot() with a batch of legacy session files in which
 * exactly one file already has a copy at its destination.
 *
 * Required behavior:
 *   - the colliding file is skipped, both copies preserved;
 *   - every other valid file in the batch still migrates;
 *   - a second run is a no-op (idempotent);
 *   - malformed headers are never touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = join(workspaceRoot, ".prale-eval", ".tmp-migrations");
const agentDir = join(scratchRoot, "agent");

/** Same encoding as session-manager.ts / migrations.ts. */
function sessionDirFor(cwd) {
	return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function legacyFile(index) {
	return {
		name: `legacy-${index}.jsonl`,
		cwd: `/projects/alpha-${index}`,
		content: `${JSON.stringify({ type: "session", id: `session-${index}`, cwd: `/projects/alpha-${index}` })}\n${JSON.stringify(
			{ type: "message", id: `m-${index}` },
		)}\n`,
	};
}

/** Sorted snapshot of every file under agentDir: relative path -> content. */
function snapshotTree(dir, base = dir, out = new Map()) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) snapshotTree(full, base, out);
		else out.set(full.slice(base.length + 1), readFileSync(full, "utf8"));
	}
	return out;
}

rmSync(scratchRoot, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });

try {
	const legacy = Array.from({ length: 8 }, (_, index) => legacyFile(index));
	for (const file of legacy) writeFileSync(join(agentDir, file.name), file.content);

	// Malformed / non-session headers must survive untouched.
	const malformed = [
		{ name: "broken.jsonl", content: "this is not json\nsecond line\n" },
		{ name: "missing-cwd.jsonl", content: `${JSON.stringify({ type: "session" })}\n` },
		{ name: "blank.jsonl", content: "\n" },
		{ name: "other-type.jsonl", content: `${JSON.stringify({ type: "message", cwd: "/projects/ignored" })}\n` },
	];
	for (const file of malformed) writeFileSync(join(agentDir, file.name), file.content);

	// Pick the first valid file in the directory's own read order (the order the
	// production loop sees) and give it an existing destination copy. Using the
	// real read order keeps fault detection deterministic: the colliding file is
	// processed before the remaining valid files.
	const readOrder = readdirSync(agentDir).filter((name) => name.endsWith(".jsonl"));
	const legacyNames = new Set(legacy.map((file) => file.name));
	const colliderName = readOrder.find((name) => legacyNames.has(name));
	assert.ok(colliderName, "setup: expected at least one legacy session file in the batch");
	const collider = legacy.find((file) => file.name === colliderName);
	const followers = readOrder.filter((name) => legacyNames.has(name) && name !== colliderName);
	assert.ok(
		followers.length > 0,
		"setup: expected valid session files ordered after the colliding file so a premature stop is observable",
	);

	const colliderTargetDir = sessionDirFor(collider.cwd);
	mkdirSync(colliderTargetDir, { recursive: true });
	const colliderTarget = join(colliderTargetDir, collider.name);
	const preservedTargetContent = `${JSON.stringify({ type: "session", id: "already-there", cwd: collider.cwd })}\n`;
	writeFileSync(colliderTarget, preservedTargetContent);

	const migrations = await loadMigrations(workspaceRoot, agentDir);
	assert.equal(
		typeof migrations.migrateSessionsFromAgentRoot,
		"function",
		"migrations module must export migrateSessionsFromAgentRoot",
	);

	// --- First run ---------------------------------------------------------
	migrations.migrateSessionsFromAgentRoot();

	// Collision: both copies preserved, destination not overwritten.
	assert.ok(
		existsSync(join(agentDir, collider.name)),
		`colliding file ${collider.name} must stay in the agent root (source copy preserved)`,
	);
	assert.equal(
		readFileSync(join(agentDir, collider.name), "utf8"),
		collider.content,
		`colliding source copy ${collider.name} must be preserved byte-for-byte`,
	);
	assert.ok(existsSync(colliderTarget), `colliding destination ${collider.name} must be preserved`);
	assert.equal(
		readFileSync(colliderTarget, "utf8"),
		preservedTargetContent,
		"the pre-existing destination copy must not be overwritten by the legacy source",
	);

	// The rest of the batch must continue migrating.
	for (const file of legacy) {
		if (file.name === collider.name) continue;
		assert.ok(
			!existsSync(join(agentDir, file.name)),
			`non-colliding file ${file.name} must be moved out of the agent root; a collision must not stop the batch`,
		);
		const destination = join(sessionDirFor(file.cwd), file.name);
		assert.ok(existsSync(destination), `non-colliding file ${file.name} must be migrated to ${destination}`);
		assert.equal(
			readFileSync(destination, "utf8"),
			file.content,
			`migrated file ${file.name} must keep its content`,
		);
	}

	// Malformed headers untouched and never relocated.
	for (const file of malformed) {
		const sourcePath = join(agentDir, file.name);
		assert.ok(existsSync(sourcePath), `malformed file ${file.name} must remain in the agent root`);
		assert.equal(
			readFileSync(sourcePath, "utf8"),
			file.content,
			`malformed file ${file.name} must be left byte-for-byte intact`,
		);
	}

	// --- Second run: idempotent --------------------------------------------
	const before = snapshotTree(agentDir);
	migrations.migrateSessionsFromAgentRoot();
	const after = snapshotTree(agentDir);
	assert.deepEqual(
		[...after.entries()].sort(),
		[...before.entries()].sort(),
		"a repeated migration run must not move, add, or rewrite any file",
	);

	console.log(
		`migration regression: ${legacy.length - 1} files migrated, 1 collision skipped with both copies preserved, ${malformed.length} malformed headers untouched, second run idempotent`,
	);
} finally {
	rmSync(scratchRoot, { recursive: true, force: true });
}
