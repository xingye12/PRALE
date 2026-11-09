/**
 * Standalone regression for migrateSessionsFromAgentRoot (session cwd encoding).
 *
 * Loads the real production TypeScript module through .prale-eval/subject.mjs
 * (Node 24 type stripping + VM modules) with only boundary fakes, and asserts
 * the real migration behavior against a real temporary agentDir.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(workspaceRoot, ".prale-eval", ".tmp-regression");

function freshAgentDir(label) {
	const dir = path.join(tmpRoot, label);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSession(agentDir, fileName, header, extraLines = []) {
	const text = [JSON.stringify(header), ...extraLines].join("\n") + "\n";
	const bytes = Buffer.from(text, "utf8");
	writeFileSync(path.join(agentDir, fileName), bytes);
	return bytes;
}

function readSession(pathname) {
	return readFileSync(pathname);
}

/** Run the real exported migration function once against a real agentDir. */
async function runMigration(agentDir) {
	const module = await loadMigrations(workspaceRoot, agentDir);
	assert.equal(
		typeof module.migrateSessionsFromAgentRoot,
		"function",
		"production module must export migrateSessionsFromAgentRoot",
	);
	module.migrateSessionsFromAgentRoot();
	return module;
}

function sessionEntries(agentDir) {
	const sessionsDir = path.join(agentDir, "sessions");
	if (!existsSync(sessionsDir)) return [];
	return readdirSync(sessionsDir).sort();
}

// Extra message lines that must survive byte-for-byte (multibyte + CRLF + no
// trailing newline on the last logical record).
const PAYLOAD_LINES = [
	'{"type":"message","role":"user","content":"héllo 🌍 — ünïcode"}',
	'{"type":"message","role":"assistant","content":"first\\nsecond"}\r',
	'{"type":"message","role":"user","content":"trailing"}',
];

async function checkEncodingCases() {
	const cases = [
		{
			label: "windows-drive",
			cwd: "C:\\Users\\Alice\\My Project",
			expectedDir: "--C--Users-Alice-My Project--",
		},
		{
			label: "windows-drive-forward-slashes",
			cwd: "C:/Users/Bob/src",
			expectedDir: "--C--Users-Bob-src--",
		},
		{
			label: "posix",
			cwd: "/home/dev/project",
			expectedDir: "--home-dev-project--",
		},
		{
			label: "unc",
			cwd: "\\\\fileserver\\share\\team",
			expectedDir: "---fileserver-share-team--",
		},
		{
			label: "posix-backslash-remainder",
			cwd: "/mnt/win\\Users\\Carol",
			expectedDir: "--mnt-win-Users-Carol--",
		},
	];

	for (const testCase of cases) {
		const agentDir = freshAgentDir(testCase.label);
		const fileName = "session.jsonl";
		const bytes = writeSession(
			agentDir,
			fileName,
			{ type: "session", version: 1, id: `id-${testCase.label}`, cwd: testCase.cwd },
			PAYLOAD_LINES,
		);

		await runMigration(agentDir);

		assert.equal(
			existsSync(path.join(agentDir, fileName)),
			false,
			`[${testCase.label}] session should be moved out of the agent root`,
		);
		assert.deepEqual(
			sessionEntries(agentDir),
			[testCase.expectedDir],
			`[${testCase.label}] cwd ${JSON.stringify(testCase.cwd)} must encode to ${JSON.stringify(testCase.expectedDir)}`,
		);

		const destination = path.join(agentDir, "sessions", testCase.expectedDir, fileName);
		assert.ok(existsSync(destination), `[${testCase.label}] expected session file at ${destination}`);
		assert.deepEqual(
			readSession(destination),
			bytes,
			`[${testCase.label}] migrated session bytes must be preserved exactly`,
		);
		for (const entry of readdirSync(path.join(agentDir, "sessions"))) {
			assert.ok(
				!/[\\:]/.test(entry),
				`[${testCase.label}] encoded directory name must not keep slashes, backslashes or colons: ${JSON.stringify(entry)}`,
			);
		}
	}
}

async function checkInvalidHeadersAreIgnored() {
	const agentDir = freshAgentDir("invalid-headers");
	const invalid = [
		["not-json.jsonl", "this is not json at all\n"],
		["wrong-type.jsonl", '{"type":"message","content":"hi"}\n'],
		["missing-cwd.jsonl", '{"type":"session","version":1}\n'],
		["empty.jsonl", ""],
		["blank-first-line.jsonl", "\n{\"type\":\"session\",\"cwd\":\"/tmp/later\"}\n"],
	];
	const original = new Map();
	for (const [fileName, text] of invalid) {
		const bytes = Buffer.from(text, "utf8");
		writeFileSync(path.join(agentDir, fileName), bytes);
		original.set(fileName, bytes);
	}
	writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"dark"}\n');

	await runMigration(agentDir);

	for (const [fileName] of invalid) {
		const pathname = path.join(agentDir, fileName);
		assert.ok(existsSync(pathname), `invalid header session ${fileName} must be left in place`);
		assert.deepEqual(readSession(pathname), original.get(fileName), `${fileName} bytes must be untouched`);
	}
	assert.equal(
		existsSync(path.join(agentDir, "settings.json")),
		true,
		"non-.jsonl files must be ignored by the migration",
	);
	assert.deepEqual(
		sessionEntries(agentDir),
		[],
		"no session directory may be created for unparsable or non-session headers",
	);
}

async function checkNeverOverwritesExistingDestination() {
	const agentDir = freshAgentDir("collision");
	const sourceName = "collide.jsonl";
	const sourceBytes = writeSession(
		agentDir,
		sourceName,
		{ type: "session", version: 1, id: "newer", cwd: "/srv/data/share" },
		PAYLOAD_LINES,
	);

	const existingDir = path.join(agentDir, "sessions", "--srv-data-share--");
	mkdirSync(existingDir, { recursive: true });
	const existingBytes = Buffer.from('{"type":"session","id":"already-there"}\n', "utf8");
	writeFileSync(path.join(existingDir, sourceName), existingBytes);
	writeFileSync(path.join(existingDir, "unrelated.jsonl"), Buffer.from("keep me\n", "utf8"));

	await runMigration(agentDir);

	assert.ok(existsSync(path.join(agentDir, sourceName)), "source must remain when the destination already exists");
	assert.deepEqual(
		readSession(path.join(agentDir, sourceName)),
		sourceBytes,
		"unmigrated source bytes must be untouched",
	);
	assert.deepEqual(
		readSession(path.join(existingDir, sourceName)),
		existingBytes,
		"an existing destination must never be overwritten",
	);
	assert.deepEqual(sessionEntries(agentDir), ["--srv-data-share--"], "no extra session directory may appear");
	assert.deepEqual(
		readdirSync(existingDir).sort(),
		[sourceName, "unrelated.jsonl"].sort(),
		"existing session directory contents must be preserved",
	);
}

async function checkRepeatedRunsAreSafe() {
	const agentDir = freshAgentDir("repeat");
	const fileName = "repeat.jsonl";
	const bytes = writeSession(
		agentDir,
		fileName,
		{ type: "session", version: 1, id: "repeat", cwd: "D:\\Work\\Repo" },
		PAYLOAD_LINES,
	);

	await runMigration(agentDir);
	const afterFirst = sessionEntries(agentDir);
	assert.deepEqual(afterFirst, ["--D--Work-Repo--"], "first run must encode the drive-letter cwd");

	// Two more runs: no throw, no duplicates, no data loss, stable result.
	await runMigration(agentDir);
	await runMigration(agentDir);

	assert.deepEqual(sessionEntries(agentDir), afterFirst, "repeated runs must not create new directories");
	assert.equal(
		readdirSync(path.join(agentDir, "sessions", "--D--Work-Repo--")).length,
		1,
		"repeated runs must not duplicate the migrated session",
	);
	assert.deepEqual(
		readSession(path.join(agentDir, "sessions", "--D--Work-Repo--", fileName)),
		bytes,
		"repeated runs must keep the migrated session bytes intact",
	);
	assert.equal(
		readdirSync(agentDir).filter((entry) => entry.endsWith(".jsonl")).length,
		0,
		"no .jsonl file may remain in the agent root after repeated runs",
	);
}

async function checkEmptyAndMissingAgentDirAreSafe() {
	const emptyAgentDir = freshAgentDir("empty-agent-dir");
	await runMigration(emptyAgentDir);
	assert.deepEqual(sessionEntries(emptyAgentDir), [], "an empty agent dir must stay empty");

	const missingAgentDir = path.join(tmpRoot, "does-not-exist");
	await runMigration(missingAgentDir);
	assert.equal(existsSync(missingAgentDir), false, "a missing agent dir must not be created by the migration");
}

rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

try {
	await checkEncodingCases();
	await checkInvalidHeadersAreIgnored();
	await checkNeverOverwritesExistingDestination();
	await checkRepeatedRunsAreSafe();
	await checkEmptyAndMissingAgentDirAreSafe();
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("session migration regression: all assertions passed");
