/**
 * Regression for session-migration/transfer.
 *
 * Exercises the real `migrateSessionsFromAgentRoot` production function through
 * `.prale-eval/subject.mjs` (real fs/path, caller-owned temp agentDir) and asserts
 * that legacy `~/.pi/agent/*.jsonl` sessions are relocated into the canonical
 * encoded session directory for POSIX, drive-letter and UNC cwds, that session
 * bytes survive unchanged, invalid headers are ignored, an existing destination
 * is never overwritten, and repeated runs stay safe.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

/**
 * Independent, character-by-character statement of the required encoding:
 * drop exactly one leading slash/backslash, then turn every slash, backslash
 * and colon into "-", wrapped in "--".
 */
function encodedDirName(cwd) {
	let rest = cwd;
	if (rest.startsWith("/") || rest.startsWith("\\")) rest = rest.slice(1);
	let encoded = "";
	for (const ch of rest) encoded += ch === "/" || ch === "\\" || ch === ":" ? "-" : ch;
	return `--${encoded}--`;
}

function sessionBytes(cwd, extraLines = []) {
	const header = JSON.stringify({ type: "session", version: 3, id: `sess-${cwd.length}`, timestamp: "2025-01-01T00:00:00.000Z", cwd });
	return `${[header, ...extraLines].join("\n")}\n`;
}

const posixCwd = "/home/alice/work/demo";
const driveCwd = "C:\\Users\\alice\\work\\demo";
const forwardDriveCwd = "D:/projects/app";
const uncCwd = "\\\\fileserver\\team\\share\\demo";

const fixtures = [
	{ file: "posix-session.jsonl", cwd: posixCwd, bytes: sessionBytes(posixCwd, [JSON.stringify({ type: "message", role: "user", content: "hi" }), JSON.stringify({ type: "message", role: "assistant", content: "hello" })]) },
	{ file: "drive-session.jsonl", cwd: driveCwd, bytes: sessionBytes(driveCwd, [JSON.stringify({ type: "message", role: "user", content: "windows" })]) },
	{ file: "forward-drive-session.jsonl", cwd: forwardDriveCwd, bytes: sessionBytes(forwardDriveCwd) },
	// CRLF session: byte preservation must not depend on line-ending normalization.
	{ file: "unc-session.jsonl", cwd: uncCwd, bytes: sessionBytes(uncCwd, [JSON.stringify({ type: "message", role: "user", content: "unc" })]).replace(/\n/g, "\r\n") },
];

// Files whose headers must be ignored, left byte-identical at the agent root.
const untouched = [
	{ file: "not-json.jsonl", bytes: "{ this is not json\nstill data\n" },
	{ file: "wrong-type.jsonl", bytes: `${JSON.stringify({ type: "message", cwd: "/home/alice/work/demo" })}\n` },
	{ file: "missing-cwd.jsonl", bytes: `${JSON.stringify({ type: "session", id: "x" })}\n` },
];

const collisionCwd = "/home/alice/work/demo";
const collisionFile = "collision-session.jsonl";
const collisionSource = sessionBytes(collisionCwd, [JSON.stringify({ type: "message", role: "user", content: "must not clobber" })]);
const collisionExisting = "PRE-EXISTING-DESTINATION\n";

const tmpRoot = mkdtempSync(path.join(here, ".tmp-migration-"));
const agentDir = path.join(tmpRoot, "agent");

try {
	mkdirSync(agentDir, { recursive: true });
	for (const fixture of fixtures) writeFileSync(path.join(agentDir, fixture.file), fixture.bytes);
	for (const entry of untouched) writeFileSync(path.join(agentDir, entry.file), entry.bytes);
	writeFileSync(path.join(agentDir, collisionFile), collisionSource);

	// Pre-create the canonical destination for the collision file with foreign content.
	const collisionDir = path.join(agentDir, "sessions", encodedDirName(collisionCwd));
	mkdirSync(collisionDir, { recursive: true });
	writeFileSync(path.join(collisionDir, collisionFile), collisionExisting);

	const migrations = await loadMigrations(root, agentDir);
	assert.equal(typeof migrations.migrateSessionsFromAgentRoot, "function", "production migrateSessionsFromAgentRoot must be exported");

	migrations.migrateSessionsFromAgentRoot();

	// 1. POSIX, drive-letter, forward-slash drive and UNC sessions land in the canonical directory.
	for (const fixture of fixtures) {
		const expectedDir = path.join(agentDir, "sessions", encodedDirName(fixture.cwd));
		const expectedPath = path.join(expectedDir, fixture.file);
		assert.ok(existsSync(expectedPath), `${fixture.cwd} must migrate to ${expectedDir} (got: ${readdirSync(path.join(agentDir, "sessions")).join(", ")})`);
		assert.equal(readFileSync(expectedPath).toString("utf8"), fixture.bytes, `${fixture.file} bytes must be preserved verbatim`);
		assert.ok(!existsSync(path.join(agentDir, fixture.file)), `${fixture.file} must no longer sit at the agent root`);
	}

	// 2. Invalid headers are ignored and their files are untouched.
	for (const entry of untouched) {
		const sourcePath = path.join(agentDir, entry.file);
		assert.ok(existsSync(sourcePath), `${entry.file} must be left in place`);
		assert.equal(readFileSync(sourcePath).toString("utf8"), entry.bytes, `${entry.file} must not be rewritten`);
	}

	// 3. An existing destination is never overwritten.
	assert.equal(readFileSync(path.join(collisionDir, collisionFile)).toString("utf8"), collisionExisting, "existing destination must not be overwritten");
	assert.ok(existsSync(path.join(agentDir, collisionFile)), "blocked source session must remain at the agent root");
	assert.equal(readFileSync(path.join(agentDir, collisionFile)).toString("utf8"), collisionSource, "blocked source session must keep its bytes");

	// 4. Repeated runs are safe: nothing changes, nothing is lost, no duplicates appear.
	const snapshot = () => {
		const result = {};
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else result[path.relative(agentDir, full)] = readFileSync(full).toString("utf8");
			}
		};
		walk(agentDir);
		return result;
	};
	const before = snapshot();
	migrations.migrateSessionsFromAgentRoot();
	migrations.migrateSessionsFromAgentRoot();
	assert.deepEqual(snapshot(), before, "repeated migration runs must be idempotent");

	console.log("regression: session migration encoding verified");
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}
