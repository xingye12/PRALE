#!/usr/bin/env node
/**
 * Cross-module regression for the legacy-session transfer path.
 *
 * Loads the real `migrations.ts` producer and the real `core/session-manager.ts`
 * consumer through `.prale-eval/subject.mjs` (only external IO boundaries are
 * supplied by the harness). The assertions only observe public behavior:
 *
 *   1. the directory migration writes into,
 *   2. the canonical directory the session manager looks up,
 *   3. what the real session reader (list/findById/open) returns from there.
 *
 * The canonical name contract is also restated locally so that a "both sides
 * agree on a wrong encoding" repair cannot pass.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const evalDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(evalDir);
const tmpRoot = join(evalDir, "tmp", "session-transfer");

/** Canonical observable encoding: strip one leading separator, encode `/`, `\` and `:`. */
function encodeCwdName(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function cleanTmp() {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(join(evalDir, "tmp"), { recursive: true, force: true });
}

/** Deterministic snapshot of every file below dir (relative path -> exact bytes). */
function snapshot(dir) {
	const files = new Map();
	if (!existsSync(dir)) return files;
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		)) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else {
				files.set(relative(dir, full), readFileSync(full).toString("base64"));
			}
		}
	};
	walk(dir);
	return files;
}

const TIMESTAMP = "2025-01-02T03:04:05.000Z";

/**
 * A legacy session file: valid header, then an intentionally malformed line and
 * a blank line, then ordered entries carrying Unicode payloads.
 */
function legacySession(id, cwd) {
	const header = { type: "session", version: 3, id, timestamp: TIMESTAMP, cwd };
	const entries = [
		{
			type: "model_change",
			id: "e1",
			parentId: null,
			timestamp: TIMESTAMP,
			provider: "acme",
			modelId: "fixture-1",
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: TIMESTAMP,
			message: { role: "user", content: [{ type: "text", text: "héllo 世界 🚀 — naïve" }] },
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: TIMESTAMP,
			message: { role: "assistant", content: [{ type: "text", text: "ответ ✓ 完了" }] },
		},
		{
			type: "custom",
			id: "e4",
			parentId: "e3",
			timestamp: TIMESTAMP,
			customType: "fixture",
			data: { nested: ["α", "β", { emoji: "🧪" }] },
		},
	];
	// One malformed record and one blank record must be skipped by the reader.
	const lines = [
		JSON.stringify(header),
		'{"type":"message","id":"torn",',
		"",
		...entries.map((entry) => JSON.stringify(entry)),
	];
	const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
	return { header, entries, bytes };
}

function writeLegacy(fileName, id, cwd) {
	const fixture = legacySession(id, cwd);
	const filePath = join(tmpRoot, "agent", fileName);
	writeFileSync(filePath, fixture.bytes);
	return fixture;
}

async function main() {
	cleanTmp();
	const agentDir = join(tmpRoot, "agent");
	mkdirSync(agentDir, { recursive: true });

	const { migration, session } = await createSessionPipeline(root, agentDir);
	assert.equal(typeof migration.migrateSessionsFromAgentRoot, "function", "migration entry point is available");
	assert.equal(typeof session.SessionManager, "function", "real session manager is available");

	const cases = [
		{
			file: "legacy-slash-backslash-colon.jsonl",
			id: "01928f3a-0000-7000-8000-000000000001",
			cwd: "/srv/Проект π/C:\\Users\\Ada Lovelace/unit:42",
		},
		{
			file: "legacy-mixed-fragments.jsonl",
			id: "01928f3a-0000-7000-8000-000000000002",
			cwd: "/home/dev/back\\slash/folder:with:colons",
		},
		{
			file: "legacy-posix-only.jsonl",
			id: "01928f3a-0000-7000-8000-000000000003",
			cwd: "/tmp/plain/posix/path",
		},
	];

	try {
		// --- observable path contract, before any IO -------------------------
		for (const scenario of cases) {
			const expected = join(agentDir, "sessions", encodeCwdName(scenario.cwd));
			assert.equal(
				session.getDefaultSessionDir(scenario.cwd, agentDir),
				expected,
				`session manager canonical directory for ${scenario.cwd}`,
			);
		}

		// --- producer side: legacy files live directly in the agent dir -------
		const fixtures = new Map();
		for (const scenario of cases) {
			fixtures.set(scenario.file, writeLegacy(scenario.file, scenario.id, scenario.cwd));
		}

		// Collision target created before migration: migration must not overwrite.
		const collisionCase = cases[0];
		const collisionCanonicalDir = join(agentDir, "sessions", encodeCwdName(collisionCase.cwd));
		mkdirSync(collisionCanonicalDir, { recursive: true });
		const collisionTarget = join(collisionCanonicalDir, "legacy-collision.jsonl");
		const collisionSentinel = Buffer.from('{"sentinel":"must survive","emoji":"🛡️"}\n', "utf8");
		writeFileSync(collisionTarget, collisionSentinel);
		const collisionSource = join(agentDir, "legacy-collision.jsonl");
		const collisionFixture = legacySession("01928f3a-0000-7000-8000-000000000004", collisionCase.cwd);
		writeFileSync(collisionSource, collisionFixture.bytes);

		migration.migrateSessionsFromAgentRoot();

		// --- consumer side: the real reader finds each migrated session ------
		for (const scenario of cases) {
			const expectedDir = join(agentDir, "sessions", encodeCwdName(scenario.cwd));
			const migratedPath = join(expectedDir, scenario.file);
			const fixture = fixtures.get(scenario.file);

			assert.equal(
				existsSync(join(agentDir, scenario.file)),
				false,
				`migration removed ${scenario.file} from the agent root`,
			);
			assert.equal(existsSync(migratedPath), true, `migration wrote ${scenario.file} to the canonical directory`);
			assert.deepEqual(
				readFileSync(migratedPath),
				fixture.bytes,
				`migrated bytes of ${scenario.file} are preserved`,
			);

			assert.equal(
				session.SessionManager.findById(scenario.cwd, scenario.id),
				migratedPath,
				`exact-id lookup resolves ${scenario.file} through the canonical directory`,
			);

			const opened = session.SessionManager.open(migratedPath);
			assert.equal(opened.getHeader()?.cwd, scenario.cwd, `header cwd of ${scenario.file} is preserved`);
			// The reader runs inside its own vm realm, so re-materialize the parsed
			// entries locally before structurally comparing them.
			assert.deepEqual(
				JSON.parse(JSON.stringify(opened.getEntries())),
				fixture.entries,
				`entry order, Unicode and fields of ${scenario.file} are preserved`,
			);

			const listed = await session.SessionManager.list(scenario.cwd);
			const info = listed.find((candidate) => candidate.id === scenario.id);
			assert.ok(info, `session list for ${scenario.cwd} contains ${scenario.file}`);
			assert.equal(info.path, migratedPath, `session list reports the canonical path of ${scenario.file}`);
			assert.equal(info.cwd, scenario.cwd, `session list reports the original cwd of ${scenario.file}`);
			assert.equal(info.messageCount, 2, `session list counts the two readable messages of ${scenario.file}`);
			assert.equal(info.firstMessage, "héllo 世界 🚀 — naïve", `session list keeps the Unicode first message`);
		}

		// --- collisions keep both sides intact -------------------------------
		assert.deepEqual(readFileSync(collisionTarget), collisionSentinel, "existing session file is never overwritten");
		assert.equal(existsSync(collisionSource), true, "colliding legacy session is not discarded");

		// --- repeated migration is a no-op -----------------------------------
		const before = snapshot(agentDir);
		migration.migrateSessionsFromAgentRoot();
		migration.migrateSessionsFromAgentRoot();
		const after = snapshot(agentDir);
		assert.deepEqual([...after.keys()], [...before.keys()], "repeated migration creates no new files or directories");
		for (const [name, bytes] of before) {
			assert.equal(after.get(name), bytes, `repeated migration preserves bytes of ${name}`);
		}

		// Every canonical directory holds exactly the migrated payload.
		for (const scenario of cases) {
			const names = readdirSync(join(agentDir, "sessions", encodeCwdName(scenario.cwd))).sort();
			const expectedNames =
				scenario.cwd === collisionCase.cwd ? [scenario.file, "legacy-collision.jsonl"].sort() : [scenario.file];
			assert.deepEqual(names, expectedNames, `canonical directory contents for ${scenario.cwd}`);
		}

		console.log("session transfer regression: ok");
	} finally {
		cleanTmp();
	}
}

await main();
