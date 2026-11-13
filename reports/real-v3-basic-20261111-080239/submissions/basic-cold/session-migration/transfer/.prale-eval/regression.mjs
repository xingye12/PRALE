/**
 * Regression: session-migration/transfer
 *
 * Exercises the real `migrateSessionsFromAgentRoot()` from
 * packages/coding-agent/src/migrations.ts through the generic subject.mjs
 * loader. Its session-directory encoding must match the canonical encoder used
 * by the session manager / JSONL repo:
 *
 *   remove ONE leading slash/backslash, then replace every slash, backslash
 *   and colon with '-', wrapped in '--' ... '--'.
 *
 * The original fault omitted the backslash from the replacement character
 * class, so Windows drive-letter and UNC cwds produced a directory literally
 * containing backslashes (e.g. `--C--Users-dev\project--`) instead of
 * `--C--Users-dev-project--`.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/coding-agent/src/migrations.ts";

/** Independent implementation of the required cwd encoding (spec, not source). */
function encodeCwd(cwd) {
	const withoutOneLeadingSeparator = cwd.replace(/^[/\\]/, "");
	return `--${withoutOneLeadingSeparator.replace(/[/\\:]/g, "-")}--`;
}

// --- boundary fakes -------------------------------------------------------
const chalkStub = new Proxy({}, { get: () => (text) => String(text) });
let agentDir = "";
const bindings = {
	default: chalkStub, // import chalk from "chalk"
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => agentDir,
	getBinDir: () => path.join(agentDir, "bin"),
	migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
	stripBom: (content) => (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content),
};

const scratchRoot = fs.mkdtempSync(path.join(root, ".prale-eval", "tmp-migration-"));
process.on("exit", () => {
	try {
		fs.rmSync(scratchRoot, { recursive: true, force: true });
	} catch {
		// best-effort cleanup so repeated runs never leave scratch state behind
	}
});
let dirCounter = 0;

/** Fresh fake ~/.pi/agent directory for one scenario. */
function makeAgentDir() {
	const dir = path.join(scratchRoot, `agent-${dirCounter++}`);
	fs.mkdirSync(dir, { recursive: true });
	agentDir = dir;
	return dir;
}

function sessionBytes(headerObj, body) {
	return Buffer.from(`${JSON.stringify(headerObj)}\n${body}`, "utf8");
}

function writeSessionFile(dir, name, bytes) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, bytes);
	return file;
}

function readDirSorted(dir) {
	try {
		return fs.readdirSync(dir).sort();
	} catch {
		return null;
	}
}

function snapshot(dir) {
	const entries = [];
	const walk = (current) => {
		for (const name of fs.readdirSync(current).sort()) {
			const full = path.join(current, name);
			if (fs.statSync(full).isDirectory()) {
				entries.push(`${path.relative(dir, full)}/`);
				walk(full);
			} else {
				entries.push(`${path.relative(dir, full)}:${fs.readFileSync(full).toString("base64")}`);
			}
		}
	};
	walk(dir);
	return entries;
}

const { migrateSessionsFromAgentRoot } = await createGraph(root, [MIGRATIONS], bindings).module(MIGRATIONS);
assert.equal(typeof migrateSessionsFromAgentRoot, "function", "migrations module must export migrateSessionsFromAgentRoot");

const failures = [];
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failures.push(`${name}: ${error?.message ?? error}`);
	}
}

// --- 1. encoding of POSIX, drive-letter, UNC and trailing-separator cwds ---
const encodingCases = [
	{ label: "posix", cwd: "/home/dev/project" },
	{ label: "drive-letter backslashes", cwd: "C:\\Users\\dev\\project" },
	{ label: "drive-letter forward slashes", cwd: "C:/Users/dev/project" },
	{ label: "drive-letter lowercase", cwd: "c:\\work\\repo" },
	{ label: "unc", cwd: "\\\\server\\share\\dir" },
	{ label: "posix trailing separator", cwd: "/home/dev/project/" },
	{ label: "windows trailing separator", cwd: "C:\\Users\\dev\\project\\" },
	{ label: "single leading backslash", cwd: "\\rooted\\path" },
];

for (const { label, cwd } of encodingCases) {
	check(`encoding/${label}`, () => {
		const dir = makeAgentDir();
		const expectedDir = encodeCwd(cwd);
		const bytes = sessionBytes({ type: "session", id: "s1", cwd }, "{\"type\":\"message\"}\n");
		writeSessionFile(dir, "session.jsonl", bytes);

		migrateSessionsFromAgentRoot();

		const sessionsRoot = path.join(dir, "sessions");
		const expectedPath = path.join(sessionsRoot, expectedDir, "session.jsonl");

		assert.equal(
			fs.existsSync(expectedPath),
			true,
			`cwd ${JSON.stringify(cwd)} must migrate to sessions/${expectedDir}/session.jsonl (found ${JSON.stringify(readDirSorted(sessionsRoot))})`,
		);
		assert.deepEqual(readDirSorted(sessionsRoot), [expectedDir], `sessions/ must contain exactly the encoded directory for ${JSON.stringify(cwd)}`);
		assert.equal(fs.existsSync(path.join(dir, "session.jsonl")), false, "source file must be moved out of the agent root");
		assert.deepEqual(fs.readFileSync(expectedPath), bytes, "session bytes must be preserved exactly");
	});
}

// --- 2. expected encoding is the canonical one (no stray separators) ------
check("encoding/canonical-shape", () => {
	assert.equal(encodeCwd("C:\\Users\\dev\\project"), "--C--Users-dev-project--");
	assert.equal(encodeCwd("\\\\server\\share\\dir"), "---server-share-dir--");
	assert.equal(encodeCwd("/home/dev/project"), "--home-dev-project--");
	assert.equal(encodeCwd("/home/dev/project/"), "--home-dev-project---");
});

// --- 3. invalid headers are ignored (file stays put, no throw) ------------
check("invalid-headers/ignored", () => {
	const dir = makeAgentDir();
	const notJson = writeSessionFile(dir, "not-json.jsonl", Buffer.from("this is not json\nbody", "utf8"));
	const wrongType = writeSessionFile(dir, "wrong-type.jsonl", sessionBytes({ type: "message", cwd: "/home/dev" }, "x"));
	const noCwd = writeSessionFile(dir, "no-cwd.jsonl", sessionBytes({ type: "session" }, "x"));
	const blankFirstLine = writeSessionFile(dir, "blank.jsonl", Buffer.from("\nrest", "utf8"));
	const before = [notJson, wrongType, noCwd, blankFirstLine].map((f) => fs.readFileSync(f));

	migrateSessionsFromAgentRoot();

	[notJson, wrongType, noCwd, blankFirstLine].forEach((file, index) => {
		assert.equal(fs.existsSync(file), true, `${path.basename(file)} must be left in the agent root`);
		assert.deepEqual(fs.readFileSync(file), before[index], `${path.basename(file)} bytes must be untouched`);
	});
	assert.equal(readDirSorted(path.join(dir, "sessions")), null, "no session directories must be created for invalid headers");
});

// --- 4. valid session is migrated even when invalid files are present -----
check("mixed/valid-migrated-invalid-kept", () => {
	const dir = makeAgentDir();
	const bytes = sessionBytes({ type: "session", cwd: "D:\\data\\repo" }, "{\"type\":\"message\"}\n");
	writeSessionFile(dir, "valid.jsonl", bytes);
	writeSessionFile(dir, "invalid.jsonl", Buffer.from("garbage\n", "utf8"));

	migrateSessionsFromAgentRoot();

	const expectedPath = path.join(dir, "sessions", encodeCwd("D:\\data\\repo"), "valid.jsonl");
	assert.equal(fs.existsSync(expectedPath), true, "valid session must migrate to its encoded directory");
	assert.deepEqual(fs.readFileSync(expectedPath), bytes, "migrated session bytes must be identical");
	assert.equal(fs.existsSync(path.join(dir, "invalid.jsonl")), true, "invalid session must remain in the agent root");
	assert.equal(fs.existsSync(path.join(dir, "valid.jsonl")), false, "migrated source must be removed");
});

// --- 5. never overwrite an existing destination --------------------------
check("destination/existing-not-overwritten", () => {
	const dir = makeAgentDir();
	const cwd = "C:\\Users\\dev\\project";
	const destDir = path.join(dir, "sessions", encodeCwd(cwd));
	fs.mkdirSync(destDir, { recursive: true });
	const sentinel = Buffer.from("{\"type\":\"session\",\"cwd\":\"C:\\\\Users\\\\dev\\\\project\",\"existing\":true}\nkeep-me\n");
	const destPath = path.join(destDir, "session.jsonl");
	fs.writeFileSync(destPath, sentinel);

	const sourceBytes = sessionBytes({ type: "session", cwd }, "new-content\n");
	const sourcePath = writeSessionFile(dir, "session.jsonl", sourceBytes);

	migrateSessionsFromAgentRoot();

	assert.deepEqual(fs.readFileSync(destPath), sentinel, "existing destination must never be overwritten");
	assert.equal(fs.existsSync(sourcePath), true, "source must remain when the destination already exists");
	assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes, "unmigrated source bytes must be preserved");
});

// --- 6. repeated runs are safe (idempotent, no throw, no data loss) -----
check("repeat/idempotent", () => {
	const dir = makeAgentDir();
	const windowsBytes = sessionBytes({ type: "session", cwd: "C:\\Users\\dev\\project" }, "windows-body\n");
	const uncBytes = sessionBytes({ type: "session", cwd: "\\\\server\\share\\dir" }, "unc-body\n");
	writeSessionFile(dir, "win.jsonl", windowsBytes);
	writeSessionFile(dir, "unc.jsonl", uncBytes);

	migrateSessionsFromAgentRoot();
	const first = snapshot(dir);

	const winPath = path.join(dir, "sessions", encodeCwd("C:\\Users\\dev\\project"), "win.jsonl");
	const uncPath = path.join(dir, "sessions", encodeCwd("\\\\server\\share\\dir"), "unc.jsonl");
	assert.equal(fs.existsSync(winPath), true, "windows session must be migrated on the first run");
	assert.equal(fs.existsSync(uncPath), true, "unc session must be migrated on the first run");

	migrateSessionsFromAgentRoot();
	const second = snapshot(dir);

	assert.deepEqual(second, first, "a second migration run must change nothing");
	assert.deepEqual(fs.readFileSync(winPath), windowsBytes, "windows session bytes must survive repeated runs");
	assert.deepEqual(fs.readFileSync(uncPath), uncBytes, "unc session bytes must survive repeated runs");
	assert.deepEqual(readDirSorted(dir), ["sessions"], "agent root must only contain the sessions directory after migration");
});

// --- 7. missing agent directory is a no-op ------------------------------
check("missing-agent-dir/no-throw", () => {
	agentDir = path.join(scratchRoot, "does-not-exist");
	migrateSessionsFromAgentRoot();
	assert.equal(fs.existsSync(path.join(agentDir, "sessions")), false, "nothing must be created for a missing agent root");
});

try {
	fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {
	// best-effort cleanup
}

if (failures.length > 0) {
	assert.fail(`session migration regression failures:\n - ${failures.join("\n - ")}`);
}
console.log("session migration regression: all assertions passed");
