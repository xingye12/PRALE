/**
 * Standalone regression for the legacy session retransfer migration.
 *
 * Exercises the real `migrateSessionsFromAgentRoot` from
 * packages/coding-agent/src/migrations.ts (loaded through subject.mjs with the
 * real fs/path modules and a caller-owned temporary agentDir).
 *
 * Repaired behavior:
 *  - a destination collision skips only the colliding file (both copies stay),
 *  - the rest of the batch still migrates, including files visited later,
 *  - repeated runs are idempotent,
 *  - malformed / non-session headers are left untouched.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import { loadMigrations } from "./subject.mjs";

const root = process.cwd();
const migrationSource = path.join(root, "packages/coding-agent/src/migrations.ts");
assert.ok(existsSync(migrationSource), `expected production module at ${migrationSource}`);

const tmpRoot = mkdtempSync(path.join(root, ".prale-eval", ".tmp-session-retransfer-"));
const agentDir = path.join(tmpRoot, "agent");

/** Directory encoding used by session-manager.ts / migrations.ts. */
function encoded(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionContent(header, body = '{"type":"message","id":"m1"}\n') {
	return `${JSON.stringify(header)}\n${body}`;
}

function sessionFile(name, cwd) {
	return sessionContent({ type: "session", id: name, version: 1, cwd, timestamp: "2025-01-01T00:00:00Z" });
}

function writeSource(name, content) {
	const file = path.join(agentDir, name);
	writeFileSync(file, content);
	return file;
}

function readOrder() {
	return readdirSync(agentDir);
}

/**
 * Add a source file that readdir visits strictly after the colliding file, so
 * the batch must skip the collision and still process this one. Different
 * filesystems return different readdir orders, so candidates are probed and
 * rejected until one lands after the collision.
 */
function addFileVisitedAfter(collisionName, label, cwd) {
	for (let i = 0; i < 64; i++) {
		const name = `${label}-${i}.jsonl`;
		const content = sessionFile(name, cwd);
		writeSource(name, content);
		const names = readOrder();
		if (names.indexOf(name) > names.indexOf(collisionName)) return { name, content };
		rmSync(path.join(agentDir, name));
	}
	throw new Error(`could not create a file visited after ${collisionName}`);
}

let passed = false;
try {
	mkdirSync(agentDir, { recursive: true });

	// --- Colliding legacy session: a same-named file already lives in the target dir.
	const collisionName = "a-collision.jsonl";
	const collisionCwd = "/work/alpha";
	const collisionContent = sessionFile(collisionName, collisionCwd);
	writeSource(collisionName, collisionContent);

	const collisionDir = path.join(agentDir, "sessions", encoded(collisionCwd));
	mkdirSync(collisionDir, { recursive: true });
	const existingTarget = path.join(collisionDir, collisionName);
	const existingTargetContent = sessionContent(
		{ type: "session", id: "already-there", version: 1, cwd: collisionCwd, timestamp: "2024-06-01T00:00:00Z" },
		'{"type":"message","id":"old"}\n',
	);
	writeFileSync(existingTarget, existingTargetContent);

	// --- Malformed header and a JSON header that is not a session header.
	const malformedName = "malformed.jsonl";
	const malformedContent = "this is not json\n{\"type\":\"message\"}\n";
	writeSource(malformedName, malformedContent);
	const noCwdName = "no-cwd.jsonl";
	const noCwdContent = `${JSON.stringify({ type: "session", id: "no-cwd" })}\n`;
	writeSource(noCwdName, noCwdContent);

	// --- A second legacy session visited after the collision in this batch.
	const later = addFileVisitedAfter(collisionName, "b-later", "/work/beta");
	const laterDir = path.join(agentDir, "sessions", encoded("/work/beta"));
	const laterTarget = path.join(laterDir, later.name);

	const module = await loadMigrations(root, agentDir);

	// ================= First run =================
	module.migrateSessionsFromAgentRoot();

	// The colliding file is skipped, not fatal: later files in the batch migrate.
	assert.ok(existsSync(laterTarget), "later session should be transferred after a collision");
	assert.equal(readFileSync(laterTarget, "utf8"), later.content, "transferred session content must be preserved");
	assert.ok(!existsSync(path.join(agentDir, later.name)), "transferred source must be gone");

	// Both copies of the colliding session survive, untouched.
	assert.ok(existsSync(path.join(agentDir, collisionName)), "colliding source must remain in the agent root");
	assert.equal(
		readFileSync(path.join(agentDir, collisionName), "utf8"),
		collisionContent,
		"colliding source content must be unchanged",
	);
	assert.ok(existsSync(existingTarget), "pre-existing destination copy must remain");
	assert.equal(readFileSync(existingTarget, "utf8"), existingTargetContent, "destination copy must not be overwritten");

	// Malformed / non-session headers are untouched.
	assert.ok(existsSync(path.join(agentDir, malformedName)), "malformed header must remain untouched");
	assert.equal(readFileSync(path.join(agentDir, malformedName), "utf8"), malformedContent);
	assert.ok(existsSync(path.join(agentDir, noCwdName)), "header without cwd must remain untouched");
	assert.equal(readFileSync(path.join(agentDir, noCwdName), "utf8"), noCwdContent);

	// Only the expected session directories were created.
	assert.deepEqual(
		readdirSync(path.join(agentDir, "sessions")).sort(),
		[encoded(collisionCwd), encoded("/work/beta")].sort(),
		"unexpected session directories created",
	);

	// ================= Second run (idempotent + still continues) =================
	const another = addFileVisitedAfter(collisionName, "c-another", "/work/gamma");
	const anotherTarget = path.join(agentDir, "sessions", encoded("/work/gamma"), another.name);

	module.migrateSessionsFromAgentRoot();

	assert.ok(existsSync(anotherTarget), "a later batch on a repeated run must still transfer new sessions");
	assert.equal(readFileSync(anotherTarget, "utf8"), another.content, "second-run transfer content must be preserved");
	assert.ok(!existsSync(path.join(agentDir, another.name)), "second-run transferred source must be gone");

	// Previously migrated file is not duplicated or altered.
	assert.equal(readFileSync(laterTarget, "utf8"), later.content, "repeat run must not alter migrated sessions");
	assert.ok(!existsSync(path.join(agentDir, later.name)));

	// Collision copies and malformed files remain exactly as before.
	assert.ok(existsSync(path.join(agentDir, collisionName)));
	assert.equal(readFileSync(path.join(agentDir, collisionName), "utf8"), collisionContent);
	assert.equal(readFileSync(existingTarget, "utf8"), existingTargetContent);
	assert.ok(existsSync(path.join(agentDir, malformedName)));
	assert.equal(readFileSync(path.join(agentDir, malformedName), "utf8"), malformedContent);
	assert.ok(existsSync(path.join(agentDir, noCwdName)));
	assert.equal(readFileSync(path.join(agentDir, noCwdName), "utf8"), noCwdContent);

	// No session file was left duplicated somewhere unexpected.
	for (const name of readdirSync(agentDir)) {
		if (!name.endsWith(".jsonl")) continue;
		assert.ok(
			[name === collisionName, name === malformedName, name === noCwdName].some(Boolean),
			`unexpected unmigrated session file: ${name}`,
		);
	}
	assert.ok(statSync(laterTarget).isFile());

	passed = true;
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}

assert.ok(passed, "regression did not complete");
