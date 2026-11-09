#!/usr/bin/env node
/**
 * Regression for "session-migration/retransfer".
 *
 * Original fault: in the legacy agent-root session migration a file-name
 * collision in the destination directory aborted the whole batch
 * (`return` instead of `continue`), so every session after the colliding
 * one stayed behind in the agent root, and each later run stalled on the
 * same collision again.
 *
 * This script drives the real `packages/coding-agent/src/migrations.ts`
 * through the read-only `.prale-eval/subject.mjs` harness (real node:fs /
 * node:path, only `getAgentDir` is faked). It builds an agent root in which
 * the FIRST legacy session encountered collides with an existing destination
 * copy, then asserts the batch invariant:
 *   - the colliding session is skipped while BOTH copies survive untouched,
 *   - every other legacy session still migrates to its encoded cwd directory,
 *   - malformed / blank / non-session headers are never touched,
 *   - a repeated run is a byte-for-byte no-op (idempotent).
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".prale-eval", `.runtime-retransfer-${process.pid}`);
const agentDir = path.join(scratch, "agent");

/** Same directory encoding the migration (and session-manager) documents. */
const encodeDir = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const sessionContent = (cwd, tag) =>
	`${JSON.stringify({ type: "session", version: 3, id: `id-${tag}`, cwd, timestamp: "2025-01-01T00:00:00.000Z" })}\n` +
	`${JSON.stringify({ type: "message", role: "user", content: `hello ${tag}` })}\n`;

/** Recursive {relative path -> content} snapshot so a second run can be proven a no-op. */
function snapshot(dir, base = dir) {
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(base, full).split(path.sep).join("/");
		if (entry.isDirectory()) {
			entries.push([`${rel}/`, null], ...snapshot(full, base));
		} else {
			entries.push([rel, readFileSync(full, "utf8")]);
		}
	}
	return entries;
}

try {
	mkdirSync(agentDir, { recursive: true });

	// --- Fixture: legacy sessions that should migrate -----------------------
	const sessionCwds = new Map([
		["session-alpha.jsonl", "/work/alpha"],
		["session-beta.jsonl", "/work/beta"],
		["session-gamma.jsonl", "/work/gamma"],
		["session-delta.jsonl", "/work/delta"],
		["session-epsilon.jsonl", "/work/epsilon"],
		["session-zeta.jsonl", "/work/zeta"],
	]);
	for (const [name, cwd] of sessionCwds) {
		writeFileSync(path.join(agentDir, name), sessionContent(cwd, path.basename(name, ".jsonl")));
	}

	// --- Fixture: headers that must never be touched ------------------------
	const specials = new Map([
		["broken-header.jsonl", '{ this is not json\n{"type":"message"}\n'],
		["not-a-session.jsonl", `${JSON.stringify({ type: "message", role: "user", content: "no header here" })}\n`],
		["blank-header.jsonl", `\n${JSON.stringify({ type: "session", id: "blank", cwd: "/work/blank" })}\n`],
	]);
	for (const [name, content] of specials) {
		writeFileSync(path.join(agentDir, name), content);
	}

	// Pick the colliding session as the FIRST session file in readdir order.
	// readdirSync order is what the migration iterates, so every other session
	// file is guaranteed to come after it in the batch: the original `return`
	// fault therefore deterministically abandons them.
	const order = readdirSync(agentDir).filter((f) => f.endsWith(".jsonl"));
	const collider = order.find((name) => sessionCwds.has(name));
	assert.ok(collider, "fixture must contain at least one legacy session file");
	const afterCollider = order.slice(order.indexOf(collider) + 1).filter((name) => sessionCwds.has(name));
	assert.ok(
		afterCollider.length > 0,
		"fixture must place at least one migratable session after the colliding one in the batch",
	);

	const collideCwd = "/work/collide";
	const collideDir = path.join(agentDir, "sessions", encodeDir(collideCwd));
	mkdirSync(collideDir, { recursive: true });
	const targetCopy = `${JSON.stringify({ type: "session", version: 3, id: "already-there", cwd: collideCwd })}\n` +
		`${JSON.stringify({ type: "message", role: "assistant", content: "pre-existing destination copy" })}\n`;
	writeFileSync(path.join(collideDir, collider), targetCopy);
	writeFileSync(path.join(agentDir, collider), sessionContent(collideCwd, "colliding"));
	const colliderSource = readFileSync(path.join(agentDir, collider), "utf8");

	const movable = [...sessionCwds.keys()].filter((name) => name !== collider);

	// --- Drive the real production function ---------------------------------
	const { migrateSessionsFromAgentRoot } = await loadMigrations(root, agentDir);
	migrateSessionsFromAgentRoot();

	// 1. The batch must continue past the collision.
	for (const name of movable) {
		const cwd = sessionCwds.get(name);
		assert.equal(
			existsSync(path.join(agentDir, name)),
			false,
			`collision aborted the batch: legacy session ${name} was left in the agent root instead of migrating`,
		);
		const destination = path.join(agentDir, "sessions", encodeDir(cwd), name);
		assert.ok(existsSync(destination), `session ${name} did not arrive at ${encodeDir(cwd)}/${name}`);
		assert.equal(
			readFileSync(destination, "utf8"),
			sessionContent(cwd, path.basename(name, ".jsonl")),
			`migrated session ${name} changed content in transit`,
		);
	}

	// 2. Both copies of the colliding session are preserved, byte for byte.
	assert.ok(
		existsSync(path.join(agentDir, collider)),
		`colliding session ${collider} was deleted instead of being skipped; the source copy must survive`,
	);
	assert.equal(
		readFileSync(path.join(agentDir, collider), "utf8"),
		colliderSource,
		`colliding session ${collider} was rewritten instead of being preserved`,
	);
	assert.equal(
		readFileSync(path.join(collideDir, collider), "utf8"),
		targetCopy,
		`pre-existing destination copy ${collider} was overwritten; both copies must be preserved`,
	);

	// 3. Malformed / blank / non-session headers remain untouched.
	for (const [name, content] of specials) {
		const file = path.join(agentDir, name);
		assert.ok(existsSync(file), `non-migratable legacy file ${name} was removed`);
		assert.equal(readFileSync(file, "utf8"), content, `non-migratable legacy file ${name} was rewritten`);
	}

	// 4. Migrated sessions land in exactly their encoded cwd directories.
	const expectedDirs = [...movable.map((name) => encodeDir(sessionCwds.get(name))), encodeDir(collideCwd)];
	assert.deepEqual(
		readdirSync(path.join(agentDir, "sessions")).sort(),
		expectedDirs.sort(),
		"session directories do not match the encoded cwd of every legacy session",
	);

	// 5. A repeated run must be a byte-for-byte no-op.
	const afterFirstRun = snapshot(agentDir);
	migrateSessionsFromAgentRoot();
	const afterSecondRun = snapshot(agentDir);
	assert.deepEqual(
		afterSecondRun,
		afterFirstRun,
		"repeated migration run was not idempotent: the agent root changed on the second run",
	);
	assert.equal(readFileSync(path.join(agentDir, collider), "utf8"), colliderSource);
	assert.equal(readFileSync(path.join(collideDir, collider), "utf8"), targetCopy);

	console.log(
		`regression: collision skipped, ${movable.length} later sessions migrated, both copies preserved, idempotent`,
	);
} finally {
	// Leave no fixtures behind: the scratch root is created and removed by this run.
	rmSync(scratch, { recursive: true, force: true });
}
