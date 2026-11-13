/**
 * Regression: session-migration/retransfer
 *
 * Contract under test (packages/coding-agent/src/migrations.ts,
 * migrateSessionsFromAgentRoot):
 *   - a legacy `~/.pi/agent/*.jsonl` file whose computed session directory
 *     already holds a file with the same name must be SKIPPED, not abort the
 *     whole batch;
 *   - both copies survive (the legacy file is left where it is, the existing
 *     target is never overwritten);
 *   - every other file in the batch still migrates;
 *   - files with malformed / missing session headers are left untouched;
 *   - running the migration again changes nothing.
 *
 * The real production module is loaded from source through the read-only
 * `.prale-eval/subject.mjs` helper. Only the external boundary (`fs`) is faked
 * with an in-memory filesystem, plus the unrelated sibling modules the file
 * imports (config/keybindings/text) and `chalk`.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_MODULE = "packages/coding-agent/src/migrations.ts";

const AGENT_DIR = "/fake/home/.pi/agent";
const SESSIONS_DIR = path.posix.join(AGENT_DIR, "sessions");

/** Same encoding as session-manager.ts / migrations.ts. */
function sessionDirFor(cwd) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.posix.join(SESSIONS_DIR, safePath);
}

function headerFor(cwd) {
	return `${JSON.stringify({ type: "session", id: `sess-${cwd}`, timestamp: "2025-01-01T00:00:00Z", cwd })}\n`;
}

function legacyBody(cwd) {
	return `${headerFor(cwd)}${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`;
}

/* ------------------------------------------------------------------ */
/* In-memory `fs` boundary                                             */
/* ------------------------------------------------------------------ */

function createMemoryFs() {
	const files = new Map();
	const dirs = new Set();
	const overwrites = [];
	const ops = [];

	const norm = (value) => path.posix.normalize(String(value));

	function isDirectory(dir) {
		if (dirs.has(dir)) return true;
		const prefix = dir === "/" ? "/" : `${dir.replace(/\/+$/, "")}/`;
		for (const file of files.keys()) if (file.startsWith(prefix)) return true;
		return false;
	}

	function listNames(dir) {
		if (!isDirectory(dir)) {
			const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
			err.code = "ENOENT";
			throw err;
		}
		const prefix = dir === "/" ? "/" : `${dir.replace(/\/+$/, "")}/`;
		const names = [];
		const seen = new Set();
		const push = (name) => {
			if (!name || name.includes("/") || seen.has(name)) return;
			seen.add(name);
			names.push(name);
		};
		// Map iteration order == seeding order, so tests control batch order.
		for (const file of files.keys()) if (file.startsWith(prefix)) push(file.slice(prefix.length));
		for (const sub of dirs) if (sub !== dir && sub.startsWith(prefix)) push(sub.slice(prefix.length));
		return names;
	}

	const fs = {
		existsSync(target) {
			const file = norm(target);
			ops.push(["existsSync", file]);
			return files.has(file) || isDirectory(file);
		},
		readdirSync(target, options) {
			const dir = norm(target);
			ops.push(["readdirSync", dir]);
			if (options && (options.recursive || options.withFileTypes)) {
				throw new Error("memory fs: unsupported readdir options");
			}
			return listNames(dir);
		},
		readFileSync(target, encoding) {
			const file = norm(target);
			ops.push(["readFileSync", file]);
			if (!files.has(file)) {
				const err = new Error(`ENOENT: no such file or directory, open '${file}'`);
				err.code = "ENOENT";
				throw err;
			}
			const encodingName = typeof encoding === "string" ? encoding : encoding?.encoding;
			if (encodingName === "utf8" || encodingName === "utf-8") return files.get(file);
			throw new Error(`memory fs: unsupported read encoding ${String(encodingName)}`);
		},
		mkdirSync(target, options) {
			const dir = norm(target);
			ops.push(["mkdirSync", dir]);
			if (files.has(dir)) {
				const err = new Error(`EEXIST: file already exists, mkdir '${dir}'`);
				err.code = "EEXIST";
				throw err;
			}
			if (!options || !options.recursive) {
				if (isDirectory(dir)) {
					const err = new Error(`EEXIST: file already exists, mkdir '${dir}'`);
					err.code = "EEXIST";
					throw err;
				}
				dirs.add(dir);
				return undefined;
			}
			let current = "";
			for (const part of dir.split("/").filter(Boolean)) {
				current += `/${part}`;
				if (files.has(current)) {
					const err = new Error(`ENOTDIR: not a directory, mkdir '${dir}'`);
					err.code = "ENOTDIR";
					throw err;
				}
				dirs.add(current);
			}
			return undefined;
		},
		renameSync(from, to) {
			const source = norm(from);
			const target = norm(to);
			ops.push(["renameSync", source, target]);
			if (files.has(source)) {
				if (files.has(target)) overwrites.push([source, target]);
				files.set(target, files.get(source));
				files.delete(source);
				return undefined;
			}
			if (dirs.has(source)) {
				const prefix = `${source}/`;
				for (const [key, value] of [...files.entries()]) {
					if (key.startsWith(prefix)) {
						files.set(path.posix.join(target, key.slice(prefix.length)), value);
						files.delete(key);
					}
				}
				for (const dir of [...dirs]) {
					if (dir === source || dir.startsWith(prefix)) {
						dirs.delete(dir);
						dirs.add(path.posix.join(target, dir.slice(source.length)));
					}
				}
				return undefined;
			}
			const err = new Error(`ENOENT: no such file or directory, rename '${source}' -> '${target}'`);
			err.code = "ENOENT";
			throw err;
		},
		rmSync(target, options) {
			const entry = norm(target);
			ops.push(["rmSync", entry]);
			if (files.delete(entry)) return undefined;
			if (dirs.delete(entry)) return undefined;
			if (!(options && options.force)) {
				const err = new Error(`ENOENT: no such file or directory, rm '${entry}'`);
				err.code = "ENOENT";
				throw err;
			}
			return undefined;
		},
		writeFileSync(target, data) {
			const file = norm(target);
			ops.push(["writeFileSync", file]);
			const parent = path.posix.dirname(file);
			if (!isDirectory(parent)) {
				const err = new Error(`ENOENT: no such file or directory, open '${file}'`);
				err.code = "ENOENT";
				throw err;
			}
			files.set(file, String(data));
			return undefined;
		},
	};

	const api = {
		fs,
		overwrites,
		ops,
		/** Seed a file (creating parent directories), without logging an op. */
		seed(file, content) {
			const target = norm(file);
			let current = "";
			for (const part of target.split("/").filter(Boolean).slice(0, -1)) {
				current += `/${part}`;
				dirs.add(current);
			}
			files.set(target, content);
		},
		read(file) {
			return files.get(norm(file));
		},
		has(file) {
			return files.has(norm(file));
		},
		list(dir) {
			return listNames(norm(dir));
		},
		snapshot() {
			return [...files.entries()]
				.map(([key, value]) => `${key}\u0000${value}`)
				.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
		},
	};

	return api;
}

/* ------------------------------------------------------------------ */
/* Loading the real production module                                  */
/* ------------------------------------------------------------------ */

const chalkStub = {
	green: (value) => String(value),
	yellow: (value) => String(value),
	dim: (value) => String(value),
	red: (value) => String(value),
	bold: (value) => String(value),
};

async function loadMigrations(memoryFs) {
	const graph = createGraph(
		WORKSPACE,
		{ migrations: MIGRATIONS_MODULE },
		{
			// `import chalk from "chalk"` resolves to the synthetic `default` export.
			default: chalkStub,
			// Sibling modules of the same package; only migrateSessionsFromAgentRoot
			// is exercised, so these stay inert.
			CONFIG_DIR_NAME: ".pi",
			getAgentDir: () => AGENT_DIR,
			getBinDir: () => path.posix.join(AGENT_DIR, "bin"),
			migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
			stripBom: (content) => (String(content).startsWith("\uFEFF") ? String(content).slice(1) : String(content)),
		},
		// Fake only the filesystem boundary of the module under test.
		{ [MIGRATIONS_MODULE]: memoryFs.fs },
		{},
	);
	return graph.module("migrations");
}

async function runMigration(memoryFs, label) {
	const namespace = await loadMigrations(memoryFs);
	assert.equal(
		typeof namespace.migrateSessionsFromAgentRoot,
		"function",
		"migrations.ts must export migrateSessionsFromAgentRoot",
	);
	assert.equal(typeof namespace, "object", `${label}: module namespace must be an object`);
	memoryFs.ops.length = 0;
	try {
		namespace.migrateSessionsFromAgentRoot();
	} catch (error) {
		assert.fail(`${label}: migrateSessionsFromAgentRoot threw: ${error && error.stack ? error.stack : error}`);
	}
}

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

const PROJECT_CWD = "/work/proj";
const OTHER_CWD = "/work/other";

const FRESH = [
	["a-fresh-1.jsonl", PROJECT_CWD],
	["c-fresh-2.jsonl", PROJECT_CWD],
	["g-fresh-3.jsonl", OTHER_CWD],
];

const COLLIDING = [
	["b-collide-1.jsonl", PROJECT_CWD],
	["f-collide-2.jsonl", OTHER_CWD],
];

const OPAQUE = [
	["d-malformed.jsonl", "not json at all\n{\"still\":\"broken\"}\n"],
	["e-no-header.jsonl", `${JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:00Z" })}\n`],
	["h-empty.jsonl", ""],
	["notes.txt", "keep me\n"],
];

const BATCH_NAMES = [...FRESH, ...COLLIDING, ...OPAQUE].map(([name]) => name);

function buildScenario(order) {
	assert.deepEqual(
		[...order].sort(),
		[...BATCH_NAMES].sort(),
		"scenario order must list every batch file exactly once",
	);

	const memoryFs = createMemoryFs();
	memoryFs.seed(path.posix.join(AGENT_DIR, ".keep"), "");

	const expected = new Map();
	for (const name of order) {
		const fresh = FRESH.find(([candidate]) => candidate === name);
		if (fresh) {
			memoryFs.seed(path.posix.join(AGENT_DIR, name), legacyBody(fresh[1]));
			continue;
		}
		const colliding = COLLIDING.find(([candidate]) => candidate === name);
		if (colliding) {
			memoryFs.seed(path.posix.join(AGENT_DIR, name), legacyBody(colliding[1]));
			// Pre-existing target under the computed session dir, same file name.
			const target = path.posix.join(sessionDirFor(colliding[1]), name);
			const content = `ORIGINAL:${name}\n`;
			memoryFs.seed(target, content);
			expected.set(target, content);
			continue;
		}
		const opaque = OPAQUE.find(([candidate]) => candidate === name);
		assert.ok(opaque, `unknown batch file ${name}`);
		memoryFs.seed(path.posix.join(AGENT_DIR, name), opaque[1]);
	}

	for (const [, content] of expected) assert.ok(content.length > 0);
	return { memoryFs, expected };
}

function assertMigrated(memoryFs, label) {
	for (const [name, cwd] of FRESH) {
		const target = path.posix.join(sessionDirFor(cwd), name);
		assert.ok(
			memoryFs.has(target),
			`${label}: ${name} was not migrated to ${target} — a collision earlier in the batch aborted migration of later files`,
		);
		assert.equal(
			memoryFs.read(target),
			legacyBody(cwd),
			`${label}: migrated content of ${name} must be preserved byte-for-byte`,
		);
		assert.equal(
			memoryFs.has(path.posix.join(AGENT_DIR, name)),
			false,
			`${label}: ${name} must be moved out of the legacy agent root`,
		);
	}
}

function assertCollisionsPreserved(memoryFs, expectedTargets, label) {
	for (const [name, cwd] of COLLIDING) {
		const legacyPath = path.posix.join(AGENT_DIR, name);
		const target = path.posix.join(sessionDirFor(cwd), name);
		assert.ok(
			memoryFs.has(legacyPath),
			`${label}: colliding legacy file ${name} must be left in place so both copies survive`,
		);
		assert.equal(memoryFs.read(legacyPath), legacyBody(cwd), `${label}: legacy copy of ${name} must be untouched`);
		assert.ok(memoryFs.has(target), `${label}: existing target ${target} must still exist`);
		assert.equal(
			memoryFs.read(target),
			expectedTargets.get(target),
			`${label}: existing target ${target} must never be overwritten by the collision`,
		);
	}
	assert.deepEqual(
		memoryFs.overwrites,
		[],
		`${label}: migration renamed over an existing file: ${JSON.stringify(memoryFs.overwrites)}`,
	);
}

function assertOpaqueUntouched(memoryFs, label) {
	for (const [name, content] of OPAQUE) {
		const legacyPath = path.posix.join(AGENT_DIR, name);
		assert.ok(memoryFs.has(legacyPath), `${label}: ${name} must remain in the legacy agent root`);
		assert.equal(memoryFs.read(legacyPath), content, `${label}: ${name} must remain untouched`);
	}
	const malformedTargets = [sessionDirFor(PROJECT_CWD), sessionDirFor(OTHER_CWD)].flatMap((dir) => {
		const names = memoryFs.has(dir) ? memoryFs.list(dir) : [];
		return names.filter((name) => name !== "b-collide-1.jsonl" && name !== "f-collide-2.jsonl").map(() => dir);
	});
	assert.deepEqual(malformedTargets, [], `${label}: malformed/header-less files must not be copied into session dirs`);
}

function assertRootContents(memoryFs, label) {
	const remaining = memoryFs
		.list(AGENT_DIR)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
	const expected = [...COLLIDING, ...OPAQUE.filter(([name]) => name.endsWith(".jsonl"))]
		.map(([name]) => name)
		.sort();
	assert.deepEqual(
		remaining,
		expected,
		`${label}: legacy agent root must contain exactly the skipped colliding files and the untouched malformed files`,
	);
}

async function runOrder(order, label) {
	const { memoryFs, expected } = buildScenario(order);
	await runMigration(memoryFs, label);
	assertMigrated(memoryFs, label);
	assertCollisionsPreserved(memoryFs, expected, label);
	assertOpaqueUntouched(memoryFs, label);
	assertRootContents(memoryFs, label);

	// Idempotency: a second run must be a no-op.
	const before = memoryFs.snapshot();
	memoryFs.ops.length = 0;
	await runMigration(memoryFs, `${label} (second run)`);
	assert.deepEqual(memoryFs.snapshot(), before, `${label}: a repeated run must not change any file`);
	assert.deepEqual(
		memoryFs.overwrites,
		[],
		`${label}: repeated run overwrote an existing file: ${JSON.stringify(memoryFs.overwrites)}`,
	);
	assertMigrated(memoryFs, `${label} (second run)`);
	assertCollisionsPreserved(memoryFs, expected, `${label} (second run)`);
	assertOpaqueUntouched(memoryFs, `${label} (second run)`);
	assertRootContents(memoryFs, `${label} (second run)`);
}

const ORDERS = {
	alphabetical: ["a-fresh-1.jsonl", "b-collide-1.jsonl", "c-fresh-2.jsonl", "d-malformed.jsonl", "e-no-header.jsonl", "f-collide-2.jsonl", "g-fresh-3.jsonl", "h-empty.jsonl", "notes.txt"],
	reversed: ["notes.txt", "h-empty.jsonl", "g-fresh-3.jsonl", "f-collide-2.jsonl", "e-no-header.jsonl", "d-malformed.jsonl", "c-fresh-2.jsonl", "b-collide-1.jsonl", "a-fresh-1.jsonl"],
	collisionsFirst: ["b-collide-1.jsonl", "f-collide-2.jsonl", "a-fresh-1.jsonl", "c-fresh-2.jsonl", "g-fresh-3.jsonl", "d-malformed.jsonl", "e-no-header.jsonl", "h-empty.jsonl", "notes.txt"],
};

for (const [name, order] of Object.entries(ORDERS)) {
	await runOrder(order, `batch order "${name}"`);
}

/* A batch that is nothing but a collision must be a clean no-op. */
{
	const label = "collision-only batch";
	const memoryFs = createMemoryFs();
	const [name, cwd] = COLLIDING[0];
	memoryFs.seed(path.posix.join(AGENT_DIR, name), legacyBody(cwd));
	const target = path.posix.join(sessionDirFor(cwd), name);
	memoryFs.seed(target, `ORIGINAL:${name}\n`);
	const before = memoryFs.snapshot();
	await runMigration(memoryFs, label);
	assert.deepEqual(memoryFs.snapshot(), before, `${label}: a solo collision must not move or rewrite anything`);
	assert.deepEqual(memoryFs.overwrites, [], `${label}: a solo collision must not overwrite the target`);
}

/* A batch with no collisions keeps migrating everything (happy path guard). */
{
	const label = "no collision";
	const memoryFs = createMemoryFs();
	for (const [name, cwd] of FRESH) memoryFs.seed(path.posix.join(AGENT_DIR, name), legacyBody(cwd));
	await runMigration(memoryFs, label);
	assertMigrated(memoryFs, label);
	assert.deepEqual(memoryFs.overwrites, [], `${label}: unexpected overwrite`);
	assert.deepEqual(memoryFs.snapshot().length, FRESH.length, `${label}: unexpected files after migration`);
}

console.log("session-migration/retransfer regression: all assertions passed");
