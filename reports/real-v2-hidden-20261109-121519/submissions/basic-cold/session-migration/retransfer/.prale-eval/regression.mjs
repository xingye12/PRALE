/**
 * Regression for session-migration/retransfer.
 *
 * Incident: when one legacy session file in the ~/.pi/agent batch collided with
 * an already-migrated session of the same name, migrateSessionsFromAgentRoot()
 * bailed out of the whole loop (`return`) instead of skipping just that file, so
 * every later file in the batch silently stayed unmigrated.
 *
 * Expected behavior after the fix:
 *   - the colliding file is skipped, both copies are preserved byte-for-byte,
 *   - the remaining files in the same batch are still migrated,
 *   - malformed headers are left untouched,
 *   - running the migration again changes nothing (idempotent).
 *
 * Runs against the real production module through .prale-eval/subject.mjs
 * (real fs/path, faked getAgentDir/stripBom). No dependencies, no network.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratchRoot = join(root, ".prale-eval");
const agentDir = mkdtempSync(join(scratchRoot, "tmp-migration-"));

const write = (path, text) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
};

/** Same encoding as session-manager.ts / migrations.ts. */
const sessionDir = (agentDirPath, cwd) =>
	join(agentDirPath, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

const header = (cwd) => `${JSON.stringify({ type: "session", version: 3, id: cwd, cwd, timestamp: "2025-01-01T00:00:00.000Z" })}\n`;
const sessionBody = (cwd) => `${header(cwd)}${JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: `hello from ${cwd}` }] })}\n`;

/** Recursive snapshot of relative path -> file bytes, used for the idempotency check. */
function snapshot(dir) {
	const out = new Map();
	const walk = (current, prefix) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = join(current, entry.name);
			if (entry.isDirectory()) walk(absolute, relative);
			else out.set(relative, readFileSync(absolute, "utf8"));
		}
	};
	walk(dir, "");
	return out;
}

const assertSameSnapshot = (actual, expected, message) => {
	assert.deepEqual([...actual.keys()], [...expected.keys()], `${message}: file set changed`);
	for (const [file, content] of expected) {
		assert.equal(actual.get(file), content, `${message}: content of ${file} changed`);
	}
};

const migration = await loadMigrations(root, agentDir);
assert.equal(typeof migration.migrateSessionsFromAgentRoot, "function", "production module must export migrateSessionsFromAgentRoot");

try {
	// Legacy batch: several well-formed session files plus one malformed header.
	const legacy = [
		{ name: "legacy-1.jsonl", cwd: "/work/alpha" },
		{ name: "legacy-2.jsonl", cwd: "/work/beta" },
		{ name: "legacy-3.jsonl", cwd: "/work/gamma" },
		{ name: "legacy-4.jsonl", cwd: "/work/delta" },
	];
	const malformedName = "legacy-0-broken.jsonl";
	const malformedContent = "{ this is not a session header\n";

	for (const { name, cwd } of legacy) write(join(agentDir, name), sessionBody(cwd));
	write(join(agentDir, malformedName), malformedContent);

	// readdir order is filesystem dependent; probe it so the collision is always
	// processed before at least one later file (no files are added/removed after this).
	const order = readdirSync(agentDir).filter((name) => name.endsWith(".jsonl"));
	const validOrder = order.filter((name) => name !== malformedName);
	assert.ok(validOrder.length === legacy.length, `expected ${legacy.length} well-formed legacy files, saw ${validOrder.length}`);

	const byName = new Map(legacy.map((entry) => [entry.name, entry]));
	const colliderName = validOrder[0];
	const collider = byName.get(colliderName);
	const laterNames = validOrder.slice(1);
	assert.ok(laterNames.length >= 1, "regression needs a file that follows the colliding one in readdir order");

	// Pre-existing migrated copy that the batch entry collides with (different bytes).
	const colliderTargetPath = join(sessionDir(agentDir, collider.cwd), colliderName);
	const colliderTargetContent = `${header(collider.cwd)}${JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "already migrated copy" }] })}\n`;
	write(colliderTargetPath, colliderTargetContent);

	const original = new Map(legacy.map(({ name, cwd }) => [name, sessionBody(cwd)]));

	// ---- first run -------------------------------------------------------
	migration.migrateSessionsFromAgentRoot();

	// The colliding file is skipped only: source stays put, existing target untouched.
	assert.ok(existsSync(join(agentDir, colliderName)), `colliding file ${colliderName} must remain in the agent root`);
	assert.equal(readFileSync(join(agentDir, colliderName), "utf8"), original.get(colliderName), "colliding source copy must be preserved byte-for-byte");
	assert.ok(existsSync(colliderTargetPath), `already-migrated copy ${colliderTargetPath} must be preserved`);
	assert.equal(readFileSync(colliderTargetPath, "utf8"), colliderTargetContent, "already-migrated copy must not be overwritten");

	// Every later file in the batch is still migrated (this is the fault: `return` did not).
	for (const name of laterNames) {
		const { cwd } = byName.get(name);
		const sourcePath = join(agentDir, name);
		const targetPath = join(sessionDir(agentDir, cwd), name);
		assert.equal(existsSync(sourcePath), false, `${name} should have been migrated out of the agent root despite the earlier collision`);
		assert.ok(existsSync(targetPath), `${name} should exist at ${targetPath}`);
		assert.equal(readFileSync(targetPath, "utf8"), original.get(name), `${name} must be migrated with its content intact`);
	}

	// Malformed headers are untouched.
	assert.ok(existsSync(join(agentDir, malformedName)), "malformed header file must stay in the agent root");
	assert.equal(readFileSync(join(agentDir, malformedName), "utf8"), malformedContent, "malformed header file must not be modified");

	// Nothing was lost: every legacy file is accounted for exactly once.
	const sessionsRoot = join(agentDir, "sessions");
	const migratedFiles = existsSync(sessionsRoot)
		? readdirSync(sessionsRoot, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => entry.name)
		: [];
	assert.equal(migratedFiles.length, legacy.length, `expected ${legacy.length} migrated session files, saw ${migratedFiles.length}: ${migratedFiles.join(", ")}`);

	// ---- repeated runs are idempotent -----------------------------------
	const firstSnapshot = snapshot(agentDir);
	migration.migrateSessionsFromAgentRoot();
	assertSameSnapshot(snapshot(agentDir), firstSnapshot, "second run");
	migration.migrateSessionsFromAgentRoot();
	assertSameSnapshot(snapshot(agentDir), firstSnapshot, "third run");

	console.log("regression ok: collision skipped, remaining batch migrated, malformed header untouched, reruns idempotent");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
