/**
 * Regression: legacy session migration must never clobber an existing
 * destination session file.
 *
 * Incident: `migrateSessionsFromAgentRoot()` moved `~/.pi/agent/*.jsonl` into
 * `~/.pi/agent/sessions/<encoded-cwd>/` with a plain `renameSync`. On POSIX
 * `rename(2)` silently replaces an existing destination, so when a session with
 * the same file name already lived in the target directory its bytes were
 * destroyed and the legacy copy vanished (i.e. both copies were lost).
 *
 * Policy under test: the existing destination always wins -- neither its bytes
 * nor the colliding legacy source may change, and unrelated legacy sessions
 * keep migrating.
 *
 * The real production function is loaded through the VM harness with only the
 * process boundaries (`getAgentDir`, `chalk`, ...) faked. `fs` is the real
 * filesystem, so real rename/overwrite semantics are exercised.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./subject.mjs";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(evalDir);
const modulePath = "packages/coding-agent/src/migrations.ts";

const tempRoot = fs.mkdtempSync(path.join(evalDir, ".tmp-regression-"));
const agentDir = path.join(tempRoot, "agent");
const sessionsDir = path.join(agentDir, "sessions");

function header(cwd, id) {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd });
}

function write(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

/** Snapshot every file below `dir` as relative path -> content. */
function snapshot(dir) {
	const out = new Map();
	const walk = (current) => {
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.set(path.relative(dir, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
		}
	};
	walk(dir);
	return out;
}

// CWDs encode to `--<path with separators replaced>--`.
const projectCwd = "/home/dev/project";
const projectDirName = "--home-dev-project--";
const otherCwd = "/home/dev/other";
const otherDirName = "--home-dev-other--";

const collidingName = "aaa-collision.jsonl";
const freshName = "bbb-fresh.jsonl";
const otherName = "ccc-other-cwd.jsonl";

const collidingSource = `${header(projectCwd, "legacy-collision")}\n${JSON.stringify({ type: "message", body: "legacy source bytes" })}\n`;
const existingDestination = `${header(projectCwd, "existing-destination")}\n${JSON.stringify({ type: "message", body: "destination bytes that must survive" })}\n`;
const freshSource = `${header(projectCwd, "legacy-fresh")}\n${JSON.stringify({ type: "message", body: "fresh legacy bytes" })}\n`;
const otherSource = `${header(otherCwd, "legacy-other")}\n${JSON.stringify({ type: "message", body: "other cwd bytes" })}\n`;

const collidingSourcePath = path.join(agentDir, collidingName);
const collidingDestinationPath = path.join(sessionsDir, projectDirName, collidingName);
const freshDestinationPath = path.join(sessionsDir, projectDirName, freshName);
const otherDestinationPath = path.join(sessionsDir, otherDirName, otherName);

const original = new Map([
	[collidingName, collidingSource],
	[freshName, freshSource],
	[otherName, otherSource],
	[`sessions/${projectDirName}/${collidingName}`, existingDestination],
]);

function seed() {
	fs.rmSync(agentDir, { recursive: true, force: true });
	for (const [relative, content] of original) write(path.join(agentDir, relative), content);
}

const chalk = { green: (s) => String(s), yellow: (s) => String(s), red: (s) => String(s), dim: (s) => String(s) };

const bindings = {
	default: chalk,
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => agentDir,
	getBinDir: () => path.join(agentDir, "bin"),
	migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
	stripBom: (value) => String(value).replace(/^\uFEFF/, ""),
};

let failed = false;
try {
	const migrations = await loadModule(root, modulePath, bindings);
	assert.equal(
		typeof migrations.migrateSessionsFromAgentRoot,
		"function",
		"expected migrateSessionsFromAgentRoot to be exported from " + modulePath,
	);

	seed();
	assert.equal(fs.readFileSync(collidingDestinationPath, "utf8"), existingDestination, "seed: destination fixture");

	migrations.migrateSessionsFromAgentRoot();

	// 1. The pre-existing destination must be byte-for-byte intact.
	assert.equal(
		fs.readFileSync(collidingDestinationPath, "utf8"),
		existingDestination,
		"existing destination session was modified or overwritten by the migration",
	);

	// 2. The colliding legacy source must still exist with its own bytes.
	assert.ok(
		fs.existsSync(collidingSourcePath),
		`colliding legacy session ${collidingName} was moved or deleted; both copies must be left untouched`,
	);
	assert.equal(
		fs.readFileSync(collidingSourcePath, "utf8"),
		collidingSource,
		"colliding legacy session source was modified by the migration",
	);

	// 3. Unrelated legacy sessions must still migrate, even after the collision.
	assert.equal(fs.existsSync(path.join(agentDir, freshName)), false, `${freshName} should have been migrated`);
	assert.equal(
		fs.readFileSync(freshDestinationPath, "utf8"),
		freshSource,
		"unrelated legacy session was not migrated to its session directory with its bytes intact",
	);
	assert.equal(fs.existsSync(path.join(agentDir, otherName)), false, `${otherName} should have been migrated`);
	assert.equal(
		fs.readFileSync(otherDestinationPath, "utf8"),
		otherSource,
		"legacy session for another cwd was not migrated with its bytes intact",
	);

	// 4. Nothing else may appear, disappear, or change: exactly the two
	//    migration moves, no duplicate/renamed copies of the colliding file.
	const expected = new Map(original);
	expected.delete(freshName);
	expected.delete(otherName);
	expected.set(`sessions/${projectDirName}/${freshName}`, freshSource);
	expected.set(`sessions/${otherDirName}/${otherName}`, otherSource);

	const actual = snapshot(agentDir);
	assert.deepEqual(
		[...actual.keys()].sort(),
		[...expected.keys()].sort(),
		"migration produced an unexpected set of files (duplicate or deleted session copies)",
	);
	for (const [relative, content] of expected) {
		assert.equal(actual.get(relative), content, `unexpected bytes for ${relative} after migration`);
	}

	console.log("regression: migration collision policy preserved (destination wins, both copies untouched)");
} catch (error) {
	failed = true;
	console.error(error instanceof assert.AssertionError ? `ASSERTION FAILED: ${error.message}` : error);
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
