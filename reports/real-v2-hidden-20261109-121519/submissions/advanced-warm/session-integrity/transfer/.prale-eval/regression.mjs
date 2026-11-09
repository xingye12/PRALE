/**
 * Regression for advanced/session-integrity/transfer.
 *
 * Legacy sessions live directly in the agent dir; the startup migration moves
 * them into the session manager's per-cwd directory. Producer (migrations.ts)
 * and consumer (core/session-manager.ts) must agree on one observable path
 * contract for absolute POSIX cwd values that contain `/`, `\` and `:`.
 *
 * The real modules are linked by ./subject.mjs; only fs.readdirSync ordering,
 * getAgentDir() and the other external boundaries are fixed. Every assertion
 * below crosses a module boundary: migration writes -> the real reader looks up.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(import.meta.dirname, ".tmp-session-migration");

/** The shared contract both modules must implement (POSIX absolute cwd). */
function encodeCwd(cwd) {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/:\\]/g, "-")}--`;
}

/** Host-side deterministic snapshot of every file below dir (path + bytes). */
function snapshotDir(dir) {
	const entries = [];
	const walk = (current) => {
		for (const name of fs.readdirSync(current).sort()) {
			const full = path.join(current, name);
			const stats = fs.lstatSync(full);
			if (stats.isDirectory()) {
				entries.push(`d:${path.relative(dir, full)}`);
				walk(full);
			} else {
				entries.push(`f:${path.relative(dir, full)}:${fs.readFileSync(full).toString("hex")}`);
			}
		}
	};
	if (!fs.existsSync(dir)) return entries;
	walk(dir);
	return entries;
}

const UNICODE_TEXT = "héllo 😀 日本語 ✓ ünïcode – em—dash";
const UNICODE_ANSWER = "応答: déjà vu ✨";

function sessionFileContent(cwd, sessionId) {
	return (
		[
			JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2025-01-01T00:00:00.000Z", cwd }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01.000Z",
				message: { role: "user", content: UNICODE_TEXT, timestamp: 1 },
			}),
			// A malformed line must be skipped by the reader, not abort discovery.
			'{"type":"message","id":',
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2025-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: UNICODE_ANSWER }],
					api: "fixture-api",
					provider: "fixture-provider",
					model: "fixture-model",
					usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			}),
			JSON.stringify({
				type: "session_info",
				id: "s1",
				parentId: "m2",
				timestamp: "2025-01-01T00:00:03.000Z",
				name: `migrated ${UNICODE_TEXT}`,
			}),
		].join("\n") + "\n"
	);
}

async function newPipeline(root) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	// subject.mjs loads module sources from the workspace root; agentDir is the
	// only injected external boundary (getAgentDir).
	const pipeline = await createSessionPipeline(workspaceRoot, agentDir);
	return { ...pipeline, root, agentDir };
}

/**
 * Full round trip: legacy file in agentDir root -> migration -> real reader.
 * Asserts the canonical directory contract, bytes, unicode, entry order,
 * malformed-line tolerance and idempotent re-runs.
 */
async function verifyMigrationRoundTrip({ tag, cwd }) {
	const root = path.join(testRoot, tag);
	const { migration, session } = await newPipeline(root);
	const agentDir = path.join(root, "agent");
	const { SessionManager, loadEntriesFromFile } = session;

	const sessionId = `sess-${tag}`;
	const legacyName = `legacy-${tag}.jsonl`;
	const legacyPath = path.join(agentDir, legacyName);
	const content = sessionFileContent(cwd, sessionId);
	fs.writeFileSync(legacyPath, content);
	const originalBytes = fs.readFileSync(legacyPath);

	// 1. Both modules must derive the SAME observable directory for this cwd.
	const expectedDir = path.join(agentDir, "sessions", encodeCwd(cwd));
	assert.equal(
		session.getDefaultSessionDir(cwd, agentDir),
		expectedDir,
		`session manager lookup must encode slashes, backslashes and colons for cwd ${JSON.stringify(cwd)}`,
	);
	assert.equal(path.basename(expectedDir).includes(":"), false);
	assert.equal(path.basename(expectedDir).includes("\\"), false);

	// 2. Run the real legacy migration.
	migration.migrateSessionsFromAgentRoot();

	const migratedPath = path.join(expectedDir, legacyName);
	assert.equal(
		fs.existsSync(migratedPath),
		true,
		`migration must place ${legacyName} in the canonical session dir for cwd ${JSON.stringify(cwd)}`,
	);
	assert.equal(fs.existsSync(legacyPath), false, "the legacy file must no longer sit in the agent root");
	assert.equal(Buffer.compare(fs.readFileSync(migratedPath), originalBytes), 0, "migration must preserve bytes");

	// 3. The real session reader must discover the migrated session by cwd.
	const listed = await SessionManager.list(cwd);
	const summary = Array.from(listed, (info) => ({
		path: String(info.path),
		id: String(info.id),
		cwd: String(info.cwd),
		messageCount: Number(info.messageCount),
		firstMessage: String(info.firstMessage),
	}));
	assert.equal(summary.length, 1, `session reader must find exactly one migrated session for ${JSON.stringify(cwd)}`);
	assert.equal(summary[0].path, migratedPath);
	assert.equal(summary[0].id, sessionId);
	assert.equal(summary[0].cwd, cwd, "the header cwd must survive untouched");
	assert.equal(summary[0].messageCount, 2, "malformed lines are skipped, real entries are counted");
	assert.ok(summary[0].firstMessage.includes(UNICODE_TEXT), "unicode text must survive the migration");

	// 4. Entry order and unicode are preserved through the real loader/reader.
	const entries = loadEntriesFromFile(migratedPath);
	assert.deepEqual(Array.from(entries, (entry) => String(entry.type)), [
		"session",
		"message",
		"message",
		"session_info",
	]);
	assert.deepEqual(Array.from(entries, (entry) => String(entry.id)), [sessionId, "m1", "m2", "s1"]);
	assert.equal(entries[1].message.content, UNICODE_TEXT);
	assert.equal(entries[2].message.content[0].text, UNICODE_ANSWER);
	assert.equal(entries[3].name, `migrated ${UNICODE_TEXT}`);

	const opened = SessionManager.open(migratedPath);
	assert.equal(opened.getHeader().cwd, cwd);
	assert.deepEqual(
		Array.from(opened.getEntries(), (entry) => String(entry.id)),
		["m1", "m2", "s1"],
	);
	assert.equal(opened.getSessionDir(), expectedDir);

	// 5. Repeated migration must be a no-op and must not rewrite anything.
	const before = snapshotDir(agentDir);
	migration.migrateSessionsFromAgentRoot();
	migration.migrateSessionsFromAgentRoot();
	assert.deepEqual(snapshotDir(agentDir), before, "repeated migration must not move or rewrite files");
	assert.equal((await SessionManager.list(cwd)).length, 1);
}

/** A name collision must never destroy the file that is already in place. */
async function verifyCollisionSafety() {
	const root = path.join(testRoot, "collision");
	const { migration, session } = await newPipeline(root);
	const agentDir = path.join(root, "agent");
	const { SessionManager } = session;
	const cwd = "/srv/collision/win\\frag:stream";

	const expectedDir = path.join(agentDir, "sessions", encodeCwd(cwd));
	fs.mkdirSync(expectedDir, { recursive: true });
	const targetName = "shared-name.jsonl";
	const targetPath = path.join(expectedDir, targetName);
	const targetContent = sessionFileContent("/srv/collision/existing", "sess-existing");
	fs.writeFileSync(targetPath, targetContent);

	const legacyPath = path.join(agentDir, targetName);
	const legacyContent = sessionFileContent(cwd, "sess-incoming");
	fs.writeFileSync(legacyPath, legacyContent);

	migration.migrateSessionsFromAgentRoot();

	assert.equal(
		fs.readFileSync(targetPath, "utf8"),
		targetContent,
		"a colliding target session must never be overwritten",
	);
	assert.equal(
		fs.readFileSync(legacyPath, "utf8"),
		legacyContent,
		"the colliding legacy file must be left in place so its data is not lost",
	);
	const listedPaths = Array.from(await SessionManager.list(cwd), (info) => String(info.path));
	assert.deepEqual(listedPaths, [targetPath]);
}

async function main() {
	fs.rmSync(testRoot, { recursive: true, force: true });
	fs.mkdirSync(testRoot, { recursive: true });
	try {
		const cases = [
			{ tag: "colon", cwd: "/srv/pi/work:main/app" },
			{ tag: "backslash", cwd: "/srv/pi/work\\legacy\\deep" },
			{ tag: "mixed", cwd: "/srv/pi/win\\style:stream/app:sub\\leaf" },
			{ tag: "drive-fragment", cwd: "/mnt/c/C:\\Users\\dev\\プロジェクト 😀/repo" },
			{ tag: "unicode", cwd: "/srv/pi/ünïcode 日本語/склад:два\\три" },
		];
		for (const testCase of cases) {
			await verifyMigrationRoundTrip(testCase);
		}
		await verifyCollisionSafety();
		process.stdout.write(`regression: ${cases.length} path-contract cases + collision safety passed\n`);
	} finally {
		fs.rmSync(testRoot, { recursive: true, force: true });
	}
}

await main();
