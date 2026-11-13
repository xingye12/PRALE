/**
 * Regression: session-migration/retransfer
 *
 * `migrateSessionsFromAgentRoot()` moves legacy `~/.pi/agent/*.jsonl` sessions into
 * `~/.pi/agent/sessions/<encoded-cwd>/`. When one legacy file collides with a file that
 * already occupies its destination, the batch must skip only that file (keeping both
 * copies intact), must not overwrite the existing destination, must keep going for the
 * remaining files, must be idempotent on repeated runs, and must leave files with
 * malformed headers untouched.
 *
 * The original fault returned from the whole loop on the first collision, so every
 * later file in the batch was stranded in the legacy root forever.
 *
 * Runs the real `packages/coding-agent/src/migrations.ts` with an in-memory fs/path
 * boundary so the assertions observe production control flow, not a reimplementation.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/coding-agent/src/migrations.ts";

const AGENT_DIR = "/fake-home/.pi/agent";
const CWD = "/work/project";
const SESSION_DIR = path.join(AGENT_DIR, "sessions", "--work-project--");

/** Minimal in-memory filesystem exposing only the surface the migration touches. */
function createMemoryFileSystem() {
	const files = new Map(); // path -> contents
	const dirs = new Set(); // path

	const parentOf = (target) => path.dirname(target);
	function addDir(target) {
		if (dirs.has(target)) return;
		dirs.add(target);
		const parent = parentOf(target);
		if (parent !== target) addDir(parent);
	}

	const fs = {
		existsSync(target) {
			return dirs.has(target) || files.has(target);
		},
		mkdirSync(target) {
			addDir(target);
		},
		readdirSync(target) {
			if (!dirs.has(target)) {
				const error = new Error(`ENOENT: no such directory, scandir '${target}'`);
				error.code = "ENOENT";
				throw error;
			}
			const prefix = target.endsWith("/") ? target : `${target}/`;
			const names = new Set();
			// Insertion order is preserved so the batch order is deterministic:
			// colliding file, malformed file, then the file that must still migrate.
			for (const candidate of [...files.keys(), ...dirs]) {
				if (!candidate.startsWith(prefix)) continue;
				const rest = candidate.slice(prefix.length);
				if (rest === "") continue;
				names.add(rest.split("/")[0]);
			}
			return [...names];
		},
		readFileSync(target) {
			if (!files.has(target)) {
				const error = new Error(`ENOENT: no such file, open '${target}'`);
				error.code = "ENOENT";
				throw error;
			}
			return files.get(target);
		},
		writeFileSync(target, contents) {
			if (!dirs.has(parentOf(target))) {
				const error = new Error(`ENOENT: no such directory, open '${target}'`);
				error.code = "ENOENT";
				throw error;
			}
			files.set(target, String(contents));
		},
		renameSync(from, to) {
			if (!files.has(from)) {
				const error = new Error(`ENOENT: no such file, rename '${from}'`);
				error.code = "ENOENT";
				throw error;
			}
			// Real rename replaces the destination, so a buggy call is still observable.
			files.set(to, files.get(from));
			files.delete(from);
		},
		rmSync(target, options) {
			if (files.delete(target)) return;
			if (options?.recursive !== true && dirs.delete(target)) return;
			if (!options?.force) {
				const error = new Error(`ENOENT: no such file or directory, rm '${target}'`);
				error.code = "ENOENT";
				throw error;
			}
		},
	};

	return {
		fs,
		addFile(target, contents) {
			addDir(parentOf(target));
			files.set(target, contents);
		},
		read: (target) => files.get(target),
		has: (target) => files.has(target),
		namesIn(target) {
			// Direct children only, like readdirSync without { recursive: true }.
			const prefix = target.endsWith("/") ? target : `${target}/`;
			const names = new Set();
			for (const candidate of [...files.keys(), ...dirs]) {
				if (!candidate.startsWith(prefix)) continue;
				const rest = candidate.slice(prefix.length);
				if (rest === "") continue;
				names.add(rest.split("/")[0]);
			}
			return [...names].sort();
		},
		snapshot() {
			return {
				files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
				dirs: [...dirs].sort(),
			};
		},
	};
}

/** Load the real migration module against the fake filesystem boundary. */
async function loadMigrations(memory) {
	const graph = createGraph(
		root,
		{ migrations: MIGRATIONS },
		{
			getAgentDir: () => AGENT_DIR,
			getBinDir: () => path.join(AGENT_DIR, "bin"),
			CONFIG_DIR_NAME: ".pi",
			migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
			stripBom: (value) => value,
			default: Object.assign((text) => String(text), {
				green: (text) => String(text),
				yellow: (text) => String(text),
				red: (text) => String(text),
				dim: (text) => String(text),
			}),
		},
		{ [MIGRATIONS]: memory.fs },
	);
	const migrations = await graph.module("migrations");
	assert.equal(
		typeof migrations.migrateSessionsFromAgentRoot,
		"function",
		"migrations.ts must export migrateSessionsFromAgentRoot",
	);
	return migrations;
}

const header = (id) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2024-01-01T00:00:00.000Z", cwd: CWD });
const sessionFile = (id) =>
	`${header(id)}\n${JSON.stringify({
		type: "message",
		id: `${id}-1`,
		parentId: null,
		timestamp: "2024-01-01T00:00:01.000Z",
		message: { role: "user", content: "hello", timestamp: 1704067201000 },
	})}\n`;

async function main() {
	const memory = createMemoryFileSystem();
	memory.addFile(path.join(AGENT_DIR, "sessions", "keep.txt"), "unrelated");

	// 1. Colliding legacy file: destination already holds a *different* session file.
	const collidingSource = path.join(AGENT_DIR, "01-collision.jsonl");
	const collidingDestination = path.join(SESSION_DIR, "01-collision.jsonl");
	const collidingContents = sessionFile("collision");
	const destinationContents = `${JSON.stringify({
		type: "session",
		version: 3,
		id: "collision",
		timestamp: "2024-01-01T00:00:00.000Z",
		cwd: CWD,
		note: "pre-existing copy",
	})}\n`;
	memory.addFile(collidingSource, collidingContents);
	memory.addFile(collidingDestination, destinationContents);

	// 2. Malformed header: must be left exactly as-is and must not abort the batch.
	const malformedSource = path.join(AGENT_DIR, "02-malformed.jsonl");
	const malformedContents = '{"type":"session","id":"truncated"\n';
	memory.addFile(malformedSource, malformedContents);

	// 3. A healthy legacy file ordered after both of the above: it must still migrate.
	const laterSource = path.join(AGENT_DIR, "03-later.jsonl");
	const laterDestination = path.join(SESSION_DIR, "03-later.jsonl");
	const laterContents = sessionFile("later");
	memory.addFile(laterSource, laterContents);

	const migrations = await loadMigrations(memory);

	migrations.migrateSessionsFromAgentRoot();

	assert.equal(
		memory.has(laterSource),
		false,
		"a collision earlier in the batch must not strand later legacy sessions in the agent root",
	);
	assert.equal(memory.read(laterDestination), laterContents, "the later legacy session must be moved intact");

	assert.equal(memory.read(collidingSource), collidingContents, "the colliding source copy must be preserved");
	assert.equal(
		memory.read(collidingDestination),
		destinationContents,
		"the pre-existing destination copy must not be overwritten or removed",
	);
	assert.equal(
		memory.has(path.join(SESSION_DIR, "02-malformed.jsonl")),
		false,
		"a malformed header must not be migrated",
	);
	assert.equal(memory.read(malformedSource), malformedContents, "a malformed header must be left untouched");
	assert.deepEqual(
		memory.namesIn(AGENT_DIR),
		["01-collision.jsonl", "02-malformed.jsonl", "sessions"],
		"only non-colliding, well-formed legacy files may leave the agent root",
	);

	// Repeated runs must be idempotent: nothing changes, nothing is lost, no error thrown.
	const afterFirstRun = memory.snapshot();
	migrations.migrateSessionsFromAgentRoot();
	assert.deepEqual(memory.snapshot(), afterFirstRun, "a repeated migration run must be idempotent");
	assert.equal(memory.read(laterDestination), laterContents, "idempotent reruns must not disturb migrated files");
	assert.equal(memory.read(collidingSource), collidingContents, "idempotent reruns must keep the collision copy");
	assert.equal(memory.read(malformedSource), malformedContents, "idempotent reruns must keep malformed headers");

	console.log("regression: session-migration/retransfer passed");
}

await main();
