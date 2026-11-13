/**
 * Regression for session migration collision policy.
 *
 * Contract: `migrateSessionsFromAgentRoot()` moves legacy `*.jsonl` session
 * files from the agent root into `sessions/<encoded-cwd>/`. When the
 * destination file already exists, the destination always wins: its bytes and
 * the colliding legacy source are both left untouched, and unrelated legacy
 * files keep migrating. Nothing is ever overwritten or deleted on collision.
 *
 * The real production module is executed through the read-only
 * `.prale-eval/subject.mjs` loader; only external boundaries (config path
 * resolution, chalk, keybinding migration) are faked.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/coding-agent/src/migrations.ts";
const TEXT_UTILS = "packages/coding-agent/src/utils/text.ts";

// Sandbox directory kept inside the workspace so nothing outside it is touched.
const agentDir = path.join(root, ".prale-eval", ".tmp-session-migration");
const projectCwd = "/work/demo-project";
const safePath = `--${projectCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const correctDir = path.join(agentDir, "sessions", safePath);

const collideName = "collide.jsonl";
const freshName = "fresh.jsonl";

const header = (id) => `${JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: projectCwd })}\n`;
const legacyCollideBytes = `${header("legacy-collide")}legacy-body-collide\n`;
const destCollideBytes = `${header("dest-wins")}destination-body-kept\n`;
const legacyFreshBytes = `${header("legacy-fresh")}fresh-body\n`;

const chalk = { green: (s) => s, yellow: (s) => s, dim: (s) => s, red: (s) => s };

const bindings = {
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => agentDir,
	getBinDir: () => path.join(agentDir, "bin"),
	migrateKeybindingsConfig: () => ({ config: {}, migrated: false }),
	default: chalk,
};

function setup() {
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.mkdirSync(correctDir, { recursive: true });
	// Collision: legacy source in the agent root and a pre-existing destination.
	fs.writeFileSync(path.join(agentDir, collideName), legacyCollideBytes);
	fs.writeFileSync(path.join(correctDir, collideName), destCollideBytes);
	// Unrelated legacy file that must still be migrated.
	fs.writeFileSync(path.join(agentDir, freshName), legacyFreshBytes);
}

function cleanup() {
	fs.rmSync(agentDir, { recursive: true, force: true });
}

try {
	setup();

	const graph = createGraph(root, [MIGRATIONS, TEXT_UTILS], bindings);
	const migrations = await graph.module(MIGRATIONS);
	assert.equal(
		typeof migrations.migrateSessionsFromAgentRoot,
		"function",
		"migrateSessionsFromAgentRoot should be exported by the production module",
	);

	migrations.migrateSessionsFromAgentRoot();

	// 1) The existing destination keeps its exact bytes.
	const destPath = path.join(correctDir, collideName);
	assert.ok(fs.existsSync(destPath), "the pre-existing destination session must still exist");
	assert.equal(
		fs.readFileSync(destPath, "utf8"),
		destCollideBytes,
		"collision policy: the existing destination must not be overwritten by the legacy source",
	);

	// 2) The colliding legacy source is neither deleted nor rewritten.
	const legacyPath = path.join(agentDir, collideName);
	assert.ok(fs.existsSync(legacyPath), "the colliding legacy source must not be deleted on collision");
	assert.equal(
		fs.readFileSync(legacyPath, "utf8"),
		legacyCollideBytes,
		"the colliding legacy source bytes must remain untouched",
	);

	// 3) Migration continues for unrelated files.
	assert.equal(fs.existsSync(path.join(agentDir, freshName)), false, "an unrelated legacy session must still be moved");
	const freshDest = path.join(correctDir, freshName);
	assert.ok(fs.existsSync(freshDest), "an unrelated legacy session must still land in the correct session directory");
	assert.equal(fs.readFileSync(freshDest, "utf8"), legacyFreshBytes, "the migrated session keeps its bytes");

	// 4) Nothing else appeared in the session directory.
	assert.deepEqual(
		Array.from(fs.readdirSync(correctDir), (entry) => String(entry)).sort(),
		[collideName, freshName].sort(),
		"migration must not create or duplicate session files on collision",
	);

	console.log("session migration collision policy: destination wins, legacy source preserved, unrelated files migrated");
} finally {
	cleanup();
}
