/**
 * Cross-module regression checks for advanced/session-integrity/correction.
 *
 * Real modules linked in one graph:
 *   - packages/coding-agent/src/migrations.ts        (producer: relocates legacy session files)
 *   - packages/coding-agent/src/core/session-manager.ts (consumer: reads/repairs session files)
 *
 * Boundary fakes: agent config paths, chalk, keybindings/text helpers, path
 * helpers and the pi-ai/message factories used by the session manager.
 *
 * Every check is a synchronous observable assertion on real filesystem bytes
 * written under .prale-eval/tmp, which is removed before and after the run.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGraph } from "./subject.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(import.meta.dirname, "tmp");
const MIGRATIONS = "packages/coding-agent/src/migrations.ts";
const SESSION_MANAGER = "packages/coding-agent/src/core/session-manager.ts";

const identity = (value) => String(value);
/** chalk boundary: every style tag returns the plain string. */
const chalkStub = new Proxy(identity, { get: () => identity });

function boundaryBindings(agentDir) {
	return {
		default: chalkStub,
		// ./config.ts
		CONFIG_DIR_NAME: ".pi",
		APP_NAME: "pi",
		getAgentDir: () => agentDir,
		getBinDir: () => join(agentDir, "bin"),
		getSessionsDir: () => join(agentDir, "sessions"),
		// ./core/keybindings.ts
		migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
		// ./utils/text.ts
		stripBom: (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text),
		// ../utils/paths.ts
		normalizePath: (input) => resolve(String(input)),
		resolvePath: (input, baseDir) => resolve(baseDir === undefined ? ROOT : String(baseDir), String(input)),
		// @earendil-works/pi-ai and ./messages.ts: unused on these paths.
		getCurrentSystemMessage: () => undefined,
		uuidv7: () => "00000000-0000-7000-8000-000000000000",
		createBranchSummaryMessage: () => {
			throw new Error("Unexpected boundary call: createBranchSummaryMessage");
		},
		createCompactionSummaryMessage: () => {
			throw new Error("Unexpected boundary call: createCompactionSummaryMessage");
		},
		createCustomMessage: () => {
			throw new Error("Unexpected boundary call: createCustomMessage");
		},
	};
}

/** Read bytes, or null when the file is gone, so failures surface as assertions. */
function readIfExists(filePath) {
	return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function captureError(fn) {
	try {
		fn();
		return null;
	} catch (error) {
		return error;
	}
}

function header(id, cwd) {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd });
}

function message(id, parentId, text) {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
}

/** Session directory encoding shared by migrations.ts and session-manager.ts. */
function encodedSessionDir(agentDir, cwd) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safePath);
}

async function main() {
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });

	const agentDir = join(WORK, "agent");
	mkdirSync(agentDir, { recursive: true });

	const graph = createGraph(ROOT, [MIGRATIONS, SESSION_MANAGER], boundaryBindings(agentDir));
	const migrations = await graph.module(MIGRATIONS);
	const sessions = await graph.module(SESSION_MANAGER);

	try {
		// ---------------------------------------------------------------
		// 1. Migration collision: existing destination bytes always win and
		//    both sides survive; unrelated migrations still continue.
		// ---------------------------------------------------------------
		const cwdA = "/tmp/prale-project-a";
		const cwdB = "/tmp/prale-project-b";

		const sourceBytes = `${header("source-session", cwdA)}\n${message("source-m1", null, "from legacy file")}\n`;
		const destBytes = `${header("destination-session", cwdA)}\n${message("dest-m1", null, "already migrated")}\n`;

		const legacyFile = join(agentDir, "legacy.jsonl");
		writeFileSync(legacyFile, sourceBytes);

		const dirA = encodedSessionDir(agentDir, cwdA);
		mkdirSync(dirA, { recursive: true });
		const destFile = join(dirA, "legacy.jsonl");
		writeFileSync(destFile, destBytes);

		const otherBytes = `${header("other-session", cwdB)}\n${message("other-m1", null, "second migration")}\n`;
		writeFileSync(join(agentDir, "other.jsonl"), otherBytes);

		migrations.migrateSessionsFromAgentRoot();

		assert.strictEqual(
			readIfExists(destFile),
			destBytes,
			"collision must not overwrite existing destination bytes",
		);
		assert.strictEqual(
			readIfExists(legacyFile),
			sourceBytes,
			"collision must leave the legacy source file in place so both sides survive",
		);

		const dirB = encodedSessionDir(agentDir, cwdB);
		assert.strictEqual(readIfExists(join(agentDir, "other.jsonl")), null, "other migrations must continue");
		assert.strictEqual(
			readIfExists(join(dirB, "other.jsonl")),
			otherBytes,
			"unrelated session must still be moved to its encoded directory",
		);

		// Producer/consumer boundary: both preserved files stay readable and keep
		// their own identity after the collision.
		const destEntries = sessions.loadEntriesFromFile(destFile);
		const sourceEntries = sessions.loadEntriesFromFile(legacyFile);
		assert.strictEqual(destEntries.length, 2, "destination session must still load");
		assert.strictEqual(sourceEntries.length, 2, "legacy source session must still load");
		assert.strictEqual(destEntries[0].id, "destination-session");
		assert.strictEqual(sourceEntries[0].id, "source-session");

		const openedDest = sessions.SessionManager.open(destFile, dirA);
		const openedSource = sessions.SessionManager.open(legacyFile, dirA);
		assert.strictEqual(openedDest.getSessionId(), "destination-session");
		assert.strictEqual(openedSource.getSessionId(), "source-session");

		// ---------------------------------------------------------------
		// 2. Reader header validation happens before newline repair:
		//    a header lacking a string id is rejected and its file is not rewritten.
		// ---------------------------------------------------------------
		const readerDir = join(WORK, "reader");
		mkdirSync(readerDir, { recursive: true });

		const unterminatedTail = message("m1", null, "final record without newline");
		const cases = [
			{
				name: "header without id",
				bytes: `${JSON.stringify({
					type: "session",
					version: 3,
					timestamp: "2025-01-01T00:00:00Z",
					cwd: "/tmp/prale-project-a",
				})}\n${unterminatedTail}`,
			},
			{
				name: "header with non-string id",
				bytes: `${JSON.stringify({
					type: "session",
					version: 3,
					id: 7,
					timestamp: "2025-01-01T00:00:00Z",
					cwd: "/tmp/prale-project-a",
				})}\n${unterminatedTail}`,
			},
			{
				name: "first record is not a session header",
				bytes: '{"type":"message","id":"m1","parentId":null}',
			},
		];

		for (const { name, bytes } of cases) {
			const file = join(readerDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.jsonl`);
			writeFileSync(file, bytes);

			const entries = sessions.loadEntriesFromFile(file);
			assert.strictEqual(entries.length, 0, `invalid header must be rejected (${name})`);
			assert.strictEqual(readIfExists(file), bytes, `invalid header file must not be rewritten (${name})`);

			// Consumer boundary: SessionManager refuses the file and leaves it intact.
			const error = captureError(() => sessions.SessionManager.open(file, readerDir));
			assert.ok(error, `SessionManager.open must reject an invalid session file (${name})`);
			assert.match(String(error.message), /not a valid pi session/);
			assert.strictEqual(readIfExists(file), bytes, `SessionManager must not rewrite an invalid file (${name})`);
		}

		// ---------------------------------------------------------------
		// 3. Valid headers are still accepted and a valid unterminated final
		//    record is still repaired, through the same loader and manager.
		// ---------------------------------------------------------------
		const validBytes = `${header("valid-session", "/tmp/prale-project-a")}\n${unterminatedTail}`;
		const validFile = join(readerDir, "valid-unterminated.jsonl");
		writeFileSync(validFile, validBytes);

		const validEntries = sessions.loadEntriesFromFile(validFile);
		assert.strictEqual(validEntries.length, 2, "valid header must still load every record");
		assert.strictEqual(validEntries[0].type, "session");
		assert.strictEqual(validEntries[0].id, "valid-session");
		assert.strictEqual(readIfExists(validFile), `${validBytes}\n`, "valid final record must be newline-terminated");

		const malformedTailBytes = `${header("malformed-tail-session", "/tmp/prale-project-a")}\n{"type":"message"`;
		const malformedTailFile = join(readerDir, "valid-malformed-tail.jsonl");
		writeFileSync(malformedTailFile, malformedTailBytes);
		assert.strictEqual(sessions.loadEntriesFromFile(malformedTailFile).length, 1);
		assert.strictEqual(
			readIfExists(malformedTailFile),
			`${malformedTailBytes}\n`,
			"valid header still repairs an unterminated malformed tail",
		);

		const headerOnly = header("header-only", "/tmp/prale-project-a");
		const headerOnlyFile = join(readerDir, "valid-header-only.jsonl");
		writeFileSync(headerOnlyFile, headerOnly);
		assert.strictEqual(sessions.loadEntriesFromFile(headerOnlyFile).length, 1);
		assert.strictEqual(readIfExists(headerOnlyFile), `${headerOnly}\n`);

		const openedValid = sessions.SessionManager.open(validFile, readerDir);
		assert.strictEqual(openedValid.getSessionId(), "valid-session");
		assert.strictEqual(openedValid.getEntries().length, 1, "valid unterminated session must load its entry");

		console.log("regression: collision safety and header validation agree across modules");
	} finally {
		rmSync(WORK, { recursive: true, force: true });
	}
}

await main();
