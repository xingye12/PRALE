#!/usr/bin/env node
/**
 * Regression for `advanced/session-integrity/transfer`.
 *
 * Incident: the legacy session migration (packages/coding-agent/src/migrations.ts)
 * moved `~/.pi/agent/*.jsonl` files into a directory that the session manager
 * (packages/coding-agent/src/core/session-manager.ts) never looks at, because the
 * two sides disagreed about how a cwd is encoded into a session directory name.
 *
 * The observable contract is: `<agentDir>/sessions/--<cwd with one leading
 * separator dropped and every "/", "\" and ":" replaced by "-">--`. It has to hold
 * for absolute POSIX cwds, including ones that embed Windows-style fragments
 * (backslashes and drive letters) inside an otherwise absolute POSIX path.
 *
 * This script links the real production modules (migration producer + session
 * manager reader) through the read-only subject helper, drives the real
 * filesystem in a scratch directory under `.prale-eval/`, and asserts:
 *   1. both modules agree on the encoded directory for slash/backslash/colon cwds,
 *   2. migration output is discoverable by the real reader (list/continueRecent),
 *   3. Unicode text, entry order and file bytes survive the move,
 *   4. malformed lines are skipped without losing valid entries,
 *   5. a colliding target is never overwritten and re-running migration is a no-op.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGraph } from "./subject.mjs";

const WORKSPACE = path.resolve(import.meta.dirname, "..");
const EVAL_DIR = path.join(WORKSPACE, ".prale-eval");
const TMP_ROOT = path.join(EVAL_DIR, ".tmp-regression");

const SESSION_MANAGER = "packages/coding-agent/src/core/session-manager.ts";
const MIGRATIONS = "packages/coding-agent/src/migrations.ts";
const PATHS_UTILS = "packages/coding-agent/src/utils/paths.ts";

/** Absolute POSIX cwd with no separator/colon at all. */
const PLAIN_CWD = "/work/proj/alpha";
/** Absolute POSIX cwd with a Windows-style fragment (`C:\Users\alice\src`) inside it. */
const WINDOWS_FRAGMENT_CWD = "/work/proj/weird/windows:C\\Users\\alice\\src";
/** Absolute POSIX cwd with Unicode plus a colon plus a backslash. */
const UNICODE_CWD = "/home/проекты/日本:テスト\\sub";

const MIGRATED_ENTRY_TEXT_A = "héllo ☃ ünïcode 日本語";
const MIGRATED_ENTRY_TEXT_B = "второй ответ ✅";

/**
 * The encoding contract, stated once in the test: drop one leading separator, then
 * encode every "/", "\" and ":" as "-". Kept independent of both production modules.
 */
function expectedSessionDirName(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function expectedSessionDir(agentDir, cwd) {
	return path.join(agentDir, "sessions", expectedSessionDirName(cwd));
}

/** Legacy JSONL session: header first, then entries with one malformed line in the middle. */
function legacySessionContent({ id, cwd, firstText, secondText }) {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	});
	const first = JSON.stringify({
		type: "message",
		id: `${id}-m1`,
		parentId: null,
		timestamp: "2025-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: firstText }], timestamp: 1 },
	});
	// Truncated JSON: the reader must skip this physical line and keep the rest.
	const malformed = '{"type":"message","id":';
	const second = JSON.stringify({
		type: "message",
		id: `${id}-m2`,
		parentId: `${id}-m1`,
		timestamp: "2025-01-01T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: secondText }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 2,
		},
	});
	return `${header}\n${first}\n${malformed}\n${second}\n`;
}

function listJsonlFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => entry.name)
		.sort();
}

function cleanup() {
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		// Scratch cleanup must never mask an assertion failure.
	}
}

async function main() {
	cleanup();
	fs.mkdirSync(TMP_ROOT, { recursive: true });
	const workRoot = fs.mkdtempSync(path.join(TMP_ROOT, "run-"));

	// The fake agent dir is mutable so each phase can start from a clean store.
	let agentDir = path.join(workRoot, "agent-contract");

	// Deterministic stand-ins for boundary packages (no time, no randomness).
	let idSeed = 0;
	const deterministicUuid = () => {
		idSeed += 1;
		return `00000000-0000-7000-8000-${String(idSeed).padStart(12, "0")}`;
	};
	const unusedMessageFactory = () => {
		throw new Error("boundary message factories are not exercised by this regression");
	};

	const bindings = {
		// `../config.ts` and `./config.ts` (both modules import it under one flat map).
		APP_NAME: "pi",
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => agentDir,
		getSessionsDir: () => path.join(agentDir, "sessions"),
		getBinDir: () => path.join(agentDir, "bin"),
		// `./core/keybindings.ts` and `./utils/text.ts` boundaries of migrations.ts.
		migrateKeybindingsConfig: () => ({ config: {}, migrated: false }),
		stripBom: (text) => (typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text),
		// `chalk` default import used only for console output.
		default: { green: (s) => s, yellow: (s) => s, dim: (s) => s },
		// `@earendil-works/pi-ai` boundary of session-manager.ts.
		uuidv7: deterministicUuid,
		getCurrentSystemMessage: () => undefined,
		createBranchSummaryMessage: unusedMessageFactory,
		createCompactionSummaryMessage: unusedMessageFactory,
		createCustomMessage: unusedMessageFactory,
	};

	const graph = createGraph(
		WORKSPACE,
		{
			sessionManager: SESSION_MANAGER,
			migrations: MIGRATIONS,
			pathsUtils: PATHS_UTILS,
		},
		bindings,
	);
	const sessionManager = await graph.module("sessionManager");
	const migrations = await graph.module("migrations");

	// ---------------------------------------------------------------------
	// Phase 1: both modules agree on the encoded session directory.
	// ---------------------------------------------------------------------
	fs.mkdirSync(agentDir, { recursive: true });
	for (const cwd of [PLAIN_CWD, WINDOWS_FRAGMENT_CWD, UNICODE_CWD]) {
		const dirName = expectedSessionDirName(cwd);
		assert.ok(!/[\\:]/.test(dirName), `expected encoding to remove separators and colons: ${dirName}`);
		// Canonical producer side (session manager's default lookup path).
		assert.equal(
			sessionManager.getDefaultSessionDir(cwd),
			expectedSessionDir(agentDir, cwd),
			`session manager must encode ${cwd} into ${dirName}`,
		);
		// Persisted session manager instance resolves the same directory.
		const session = sessionManager.SessionManager.create(cwd);
		assert.equal(session.getSessionDir(), expectedSessionDir(agentDir, cwd), `SessionManager.create(${cwd})`);
		assert.equal(session.usesDefaultSessionDir(), true, "created session must use the default session dir");
		assert.equal(session.getCwd(), cwd, "session manager must keep the cwd verbatim");
	}
	// A Windows-style fragment must not leave a literal drive-letter separator behind.
	assert.equal(
		path.basename(expectedSessionDir(agentDir, WINDOWS_FRAGMENT_CWD)),
		"--work-proj-weird-windows-C-Users-alice-src--",
	);
	assert.equal(path.basename(expectedSessionDir(agentDir, UNICODE_CWD)), "--home-проекты-日本-テスト-sub--");

	// ---------------------------------------------------------------------
	// Phase 2: migration lands in the canonical directory and the real reader sees it.
	// ---------------------------------------------------------------------
	agentDir = path.join(workRoot, "agent-migrate");
	fs.mkdirSync(agentDir, { recursive: true });

	const cases = [
		{ fileName: "session-plain.jsonl", id: "sess-plain", cwd: PLAIN_CWD },
		{ fileName: "session-windows.jsonl", id: "sess-windows", cwd: WINDOWS_FRAGMENT_CWD },
		{ fileName: "session-unicode.jsonl", id: "sess-unicode", cwd: UNICODE_CWD },
	];
	const expectedBytes = new Map();
	for (const testCase of cases) {
		const content = legacySessionContent({
			id: testCase.id,
			cwd: testCase.cwd,
			firstText: MIGRATED_ENTRY_TEXT_A,
			secondText: MIGRATED_ENTRY_TEXT_B,
		});
		const legacyPath = path.join(agentDir, testCase.fileName);
		fs.writeFileSync(legacyPath, content, "utf8");
		testCase.legacyPath = legacyPath;
		expectedBytes.set(testCase.fileName, Buffer.from(content, "utf8"));
	}

	migrations.migrateSessionsFromAgentRoot();

	assert.deepEqual(listJsonlFiles(agentDir), [], "migration must drain *.jsonl from the agent root");

	for (const testCase of cases) {
		const target = path.join(expectedSessionDir(agentDir, testCase.cwd), testCase.fileName);

		// Producer/consumer boundary: the migrated file sits exactly where the
		// session manager's canonical lookup points, and not one directory over.
		assert.equal(sessionManager.getDefaultSessionDir(testCase.cwd), path.dirname(target));
		assert.equal(fs.existsSync(testCase.legacyPath), false, `legacy file must be moved: ${testCase.fileName}`);
		assert.equal(fs.existsSync(target), true, `migrated file must exist at ${target}`);

		// Bytes are preserved by the move (Unicode included).
		assert.deepEqual(fs.readFileSync(target), expectedBytes.get(testCase.fileName), "migrated bytes must be unchanged");

		// The real reader finds it and preserves order + text; the malformed line is skipped.
		const sessions = await sessionManager.SessionManager.list(testCase.cwd);
		assert.equal(sessions.length, 1, `list() must find the migrated session for ${testCase.cwd}`);
		assert.equal(sessions[0].path, target);
		assert.equal(sessions[0].cwd, testCase.cwd);
		assert.equal(sessions[0].id, testCase.id);
		assert.equal(sessions[0].messageCount, 2, "malformed line must be skipped without dropping valid entries");
		assert.equal(sessions[0].firstMessage, MIGRATED_ENTRY_TEXT_A);
		assert.equal(sessions[0].allMessagesText, `${MIGRATED_ENTRY_TEXT_A} ${MIGRATED_ENTRY_TEXT_B}`);

		// continueRecent() re-reads the same file through the discovery path.
		const recent = sessionManager.SessionManager.continueRecent(testCase.cwd);
		assert.equal(recent.getSessionFile(), target, "continueRecent() must open the migrated file");
		assert.deepEqual(
			// Array.from() copies out of the module realm before comparing.
			Array.from(recent.getEntries(), (entry) => entry.id),
			[`${testCase.id}-m1`, `${testCase.id}-m2`],
			"entry order must be preserved through the migration",
		);
		assert.deepEqual(
			Array.from(sessionManager.loadEntriesFromFile(target), (entry) => entry.id),
			[testCase.id, `${testCase.id}-m1`, `${testCase.id}-m2`],
			"raw entry loader must see header + entries in file order",
		);

		// Reading must not rewrite the migrated file.
		assert.deepEqual(fs.readFileSync(target), expectedBytes.get(testCase.fileName), "reading must not mutate the file");
	}

	// ---------------------------------------------------------------------
	// Phase 3: repeated migration is a no-op.
	// ---------------------------------------------------------------------
	const snapshot = cases.map((testCase) => ({
		target: path.join(expectedSessionDir(agentDir, testCase.cwd), testCase.fileName),
		bytes: fs.readFileSync(path.join(expectedSessionDir(agentDir, testCase.cwd), testCase.fileName)),
	}));
	migrations.migrateSessionsFromAgentRoot();
	migrations.migrateSessionsFromAgentRoot();
	assert.deepEqual(listJsonlFiles(agentDir), [], "repeated migration must not resurrect files in the agent root");
	for (const [index, testCase] of cases.entries()) {
		assert.deepEqual(fs.readFileSync(snapshot[index].target), snapshot[index].bytes, "re-migration must not touch files");
		assert.deepEqual(listJsonlFiles(path.dirname(snapshot[index].target)), [testCase.fileName]);
		const sessions = await sessionManager.SessionManager.list(testCase.cwd);
		assert.equal(sessions.length, 1, "re-migration must not duplicate sessions");
		assert.equal(sessions[0].path, snapshot[index].target);
	}

	// ---------------------------------------------------------------------
	// Phase 4: a colliding target is never overwritten.
	// ---------------------------------------------------------------------
	agentDir = path.join(workRoot, "agent-collision");
	fs.mkdirSync(agentDir, { recursive: true });

	const collisionCwd = WINDOWS_FRAGMENT_CWD;
	const collisionDir = expectedSessionDir(agentDir, collisionCwd);
	fs.mkdirSync(collisionDir, { recursive: true });

	const existingTarget = path.join(collisionDir, "session-collision.jsonl");
	const existingContent = legacySessionContent({
		id: "sess-existing",
		cwd: collisionCwd,
		firstText: "already canonical",
		secondText: "do not touch",
	});
	fs.writeFileSync(existingTarget, existingContent, "utf8");

	const legacyCollisionPath = path.join(agentDir, "session-collision.jsonl");
	const legacyCollisionContent = legacySessionContent({
		id: "sess-legacy-collision",
		cwd: collisionCwd,
		firstText: "legacy copy",
		secondText: "keep me too",
	});
	fs.writeFileSync(legacyCollisionPath, legacyCollisionContent, "utf8");

	migrations.migrateSessionsFromAgentRoot();
	migrations.migrateSessionsFromAgentRoot();

	assert.deepEqual(
		fs.readFileSync(existingTarget),
		Buffer.from(existingContent, "utf8"),
		"an existing session file must never be overwritten",
	);
	assert.equal(fs.existsSync(legacyCollisionPath), true, "a colliding legacy file must be left in place");
	assert.deepEqual(fs.readFileSync(legacyCollisionPath), Buffer.from(legacyCollisionContent, "utf8"));

	const collidedSessions = await sessionManager.SessionManager.list(collisionCwd);
	assert.deepEqual(
		Array.from(collidedSessions, (session) => session.path),
		[existingTarget],
		"only the pre-existing canonical session is visible after a collision",
	);
	assert.deepEqual(listJsonlFiles(collisionDir), ["session-collision.jsonl"]);
}

await main().finally(cleanup);
console.log("regression: legacy session migration and canonical session lookup agree on the encoded path contract");
