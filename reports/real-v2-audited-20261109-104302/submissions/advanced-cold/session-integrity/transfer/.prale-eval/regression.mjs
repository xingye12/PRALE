#!/usr/bin/env node
/**
 * Cross-module regression for the legacy-session migration incident.
 *
 * Producer: packages/coding-agent/src/migrations.ts (migrateSessionsFromAgentRoot)
 * Consumer: packages/coding-agent/src/core/session-manager.ts (canonical session
 *           directory lookup + the real JSONL reader).
 *
 * Both modules are the submitted implementations, loaded through
 * .prale-eval/subject.mjs. Only the agent-directory lookup (getAgentDir) is a
 * faked external boundary; filesystem IO, JSONL parsing and path encoding are
 * the real production code.
 *
 * Every filesystem probe is guarded by an assert.ok() so a regression surfaces
 * as an AssertionError instead of an ENOENT crash.
 *
 * Stages are chained through promises (no timers, randomness, network or real
 * clock ordering) so asynchronous reader calls observe migration results that
 * are already committed to disk.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const workspace = process.cwd();
const sandbox = path.join(workspace, ".prale-eval", ".tmp-regression");
const agentDir = path.join(sandbox, "agent");
const sessionsRoot = path.join(agentDir, "sessions");

/** The shared observable directory contract both modules must implement. */
const sessionDirName = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Absolute POSIX cwds that also carry Windows-style fragments (backslash/colon). */
const scenarioSpecs = [
	{ label: "slash+backslash+colon+unicode", segments: ["wörk space", "C:\\Users\\dev", "目录-ñ"], id: "SESS-combined-01" },
	{ label: "colon only", segments: ["ticket:1234"], id: "SESS-colon-01" },
	{ label: "backslash only", segments: ["drive\\fragment"], id: "SESS-backslash-01" },
	{ label: "plain posix", segments: ["plain"], id: "SESS-plain-01" },
];

const PREEXISTING_ID = "SESS-preexisting-01";
const COLLISION_SOURCE = "legacy-collision.jsonl";
const MALFORMED_HEADER = "broken-header.jsonl";
const MISSING_CWD = "no-cwd.jsonl";
const IGNORED_TEXT = "notes.txt";

function sessionFixture(cwd, id, tag) {
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	};
	const user = {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: "2025-01-01T00:00:01.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: `héllo 世界 🚀 ${tag} :: ${cwd}` }],
			timestamp: 1735689601000,
		},
	};
	const assistant = {
		type: "message",
		id: "entry-2",
		parentId: "entry-1",
		timestamp: "2025-01-01T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `réponse ✓ 🧪 ${tag}` }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 1735689602000,
		},
	};
	const modelChange = {
		type: "model_change",
		id: "entry-3",
		parentId: "entry-2",
		timestamp: "2025-01-01T00:00:03.000Z",
		provider: "test",
		modelId: "test-model",
	};
	// A malformed line sits between valid entries: the reader must skip it and
	// keep the remaining entries in their original order.
	const content = [
		JSON.stringify(header),
		JSON.stringify(user),
		'{"type":"message","id":"truncated',
		JSON.stringify(assistant),
		JSON.stringify(modelChange),
	].join("\n");
	return { entries: [header, user, assistant, modelChange], content: `${content}\n` };
}

const scenarios = scenarioSpecs.map((spec) => {
	const cwd = path.join(sandbox, "projects", ...spec.segments);
	const fileName = `legacy-${spec.id.toLowerCase()}.jsonl`;
	const fixture = sessionFixture(cwd, spec.id, spec.label);
	return { ...spec, cwd, fileName, ...fixture };
});
const [combined] = scenarios;

const preexistingContent = `${JSON.stringify({
	type: "session",
	version: 3,
	id: PREEXISTING_ID,
	timestamp: "2024-12-31T00:00:00.000Z",
	cwd: combined.cwd,
})}\n${JSON.stringify({
	type: "message",
	id: "pre-1",
	parentId: null,
	timestamp: "2024-12-31T00:00:01.000Z",
	message: { role: "user", content: [{ type: "text", text: "pre-existing 原始 bytes" }], timestamp: 1735603201000 },
})}\n`;

const malformedHeaderContent = '{"type":"session","id":"BROKEN"\n{"type":"session","version":3,"id":"never-used"}\n';
const missingCwdContent = `${JSON.stringify({ type: "session", version: 3, id: "SESS-no-cwd", timestamp: "2025-01-01T00:00:00.000Z" })}\n`;
const ignoredTextContent = "not a session";

/** Objects returned by the VM-loaded modules live in another realm; normalize before deep comparison. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function readIfPresent(file) {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

function expectedSessionDirs() {
	return [...new Set(scenarios.map((scenario) => sessionDirName(scenario.cwd)))].sort();
}

function prepareInputs() {
	fs.rmSync(sandbox, { recursive: true, force: true });
	fs.mkdirSync(agentDir, { recursive: true });

	for (const scenario of scenarios) {
		fs.mkdirSync(scenario.cwd, { recursive: true });
		fs.writeFileSync(path.join(agentDir, scenario.fileName), scenario.content, "utf8");
	}

	// A legacy file whose target already exists: migration must not clobber the
	// existing session bytes and must leave the legacy source in place.
	fs.writeFileSync(path.join(agentDir, COLLISION_SOURCE), scenarios[0].content, "utf8");
	const preexistingPath = path.join(sessionsRoot, sessionDirName(combined.cwd), COLLISION_SOURCE);
	fs.mkdirSync(path.dirname(preexistingPath), { recursive: true });
	fs.writeFileSync(preexistingPath, preexistingContent, "utf8");

	fs.writeFileSync(path.join(agentDir, MALFORMED_HEADER), malformedHeaderContent, "utf8");
	fs.writeFileSync(path.join(agentDir, MISSING_CWD), missingCwdContent, "utf8");
	fs.writeFileSync(path.join(agentDir, IGNORED_TEXT), ignoredTextContent, "utf8");

	return { preexistingPath };
}

const stages = [];
function stage(name, run) {
	stages.push({ name, run });
}

let pipeline;
let paths;

stage("prepare legacy session files", () => {
	paths = prepareInputs();
	assert.ok(fs.existsSync(path.join(workspace, ".prale-eval", "subject.mjs")), "run from the workspace root");
});

stage("load real migration and session modules", async () => {
	pipeline = await createSessionPipeline(workspace, agentDir);
	assert.equal(typeof pipeline.migration.migrateSessionsFromAgentRoot, "function");
	assert.equal(typeof pipeline.session.SessionManager.continueRecent, "function");
	assert.equal(typeof pipeline.session.getDefaultSessionDir, "function");
});

stage("migrate legacy sessions once", () => {
	assert.equal(pipeline.migration.migrateSessionsFromAgentRoot(), undefined, "migration returns no value");
});

stage("reader canonical directory equals the migration target directory", () => {
	for (const scenario of scenarios) {
		const expectedDir = path.join(sessionsRoot, sessionDirName(scenario.cwd));
		const readerDir = pipeline.session.getDefaultSessionDir(scenario.cwd, agentDir);
		assert.equal(
			readerDir,
			expectedDir,
			`reader canonical dir must encode slash, backslash and colon for ${scenario.label}`,
		);
		assert.ok(fs.existsSync(readerDir), `canonical session dir exists for ${scenario.label}`);
		assert.ok(fs.statSync(readerDir).isDirectory(), `canonical session dir is a directory for ${scenario.label}`);

		const migratedPath = path.join(readerDir, scenario.fileName);
		assert.ok(fs.existsSync(migratedPath), `migrated session file lands in the reader's dir for ${scenario.label}`);
		assert.equal(
			fs.existsSync(path.join(agentDir, scenario.fileName)),
			false,
			`legacy file is moved out of the agent root for ${scenario.label}`,
		);
		assert.equal(fs.readFileSync(migratedPath, "utf8"), scenario.content, `bytes preserved for ${scenario.label}`);
	}

	const names = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot).sort() : undefined;
	assert.deepEqual(names, expectedSessionDirs(), "only the canonical per-cwd session directories are created");
	for (const [name, content] of [
		[MALFORMED_HEADER, malformedHeaderContent],
		[MISSING_CWD, missingCwdContent],
		[IGNORED_TEXT, ignoredTextContent],
	]) {
		assert.equal(readIfPresent(path.join(agentDir, name)), content, `${name} is left untouched`);
	}
});

stage("real session reader resolves every migrated session", async () => {
	for (const scenario of scenarios) {
		const expectedDir = path.join(sessionsRoot, sessionDirName(scenario.cwd));
		const migratedPath = path.join(expectedDir, scenario.fileName);
		assert.ok(fs.existsSync(migratedPath), `migrated file present for ${scenario.label}`);

		assert.equal(
			plain(pipeline.session.loadEntriesFromFile(migratedPath)).length,
			scenario.entries.length,
			`raw reader keeps every valid entry and skips the malformed line for ${scenario.label}`,
		);
		assert.deepEqual(
			plain(pipeline.session.loadEntriesFromFile(migratedPath)),
			scenario.entries,
			`raw reader preserves Unicode, order and entry content for ${scenario.label}`,
		);
		// The collision scenario deliberately holds two sessions in one canonical
		// directory, so single-file discovery/resume is asserted elsewhere.
		const singleFileDir = scenario !== combined;
		if (singleFileDir) {
			assert.equal(
				pipeline.session.findMostRecentSession(expectedDir, scenario.cwd),
				migratedPath,
				`recent-session discovery finds the migrated file for ${scenario.label}`,
			);
		}
		assert.equal(
			pipeline.session.SessionManager.findById(scenario.cwd, scenario.id),
			migratedPath,
			`exact session id lookup finds the migrated file for ${scenario.label}`,
		);

		const opened = pipeline.session.SessionManager.open(migratedPath);
		assert.deepEqual(plain(opened.getHeader()), scenario.entries[0], `open() preserves the header for ${scenario.label}`);
		assert.deepEqual(
			plain(opened.getEntries()),
			scenario.entries.slice(1),
			`open() preserves entry order and content for ${scenario.label}`,
		);
		assert.equal(opened.getCwd(), scenario.cwd, `open() restores the header cwd for ${scenario.label}`);

		const listed = await pipeline.session.SessionManager.list(scenario.cwd);
		const listedEntry = listed.find((info) => info.id === scenario.id);
		assert.ok(listedEntry, `list() exposes the migrated session for ${scenario.label}`);
		assert.equal(listedEntry.path, migratedPath, `list() reports the migrated path for ${scenario.label}`);
		assert.equal(listedEntry.cwd, scenario.cwd, `list() reports the migrated cwd for ${scenario.label}`);
		assert.equal(listedEntry.messageCount, 2, `list() counts the valid messages for ${scenario.label}`);

		if (singleFileDir) {
			// Resume through the canonical default directory (no explicit sessionDir).
			const resumed = pipeline.session.SessionManager.continueRecent(scenario.cwd);
			assert.equal(resumed.getSessionFile(), migratedPath, `continueRecent resolves for ${scenario.label}`);
			assert.equal(resumed.getSessionId(), scenario.id, `continueRecent restores the id for ${scenario.label}`);
			assert.equal(resumed.getCwd(), scenario.cwd, `continueRecent restores the cwd for ${scenario.label}`);
			assert.equal(
				resumed.usesDefaultSessionDir(),
				true,
				`continueRecent uses the canonical dir for ${scenario.label}`,
			);
			assert.deepEqual(
				plain(resumed.getHeader()),
				scenario.entries[0],
				`continueRecent preserves the header for ${scenario.label}`,
			);
			assert.deepEqual(
				plain(resumed.getEntries()),
				scenario.entries.slice(1),
				`continueRecent preserves entry order and content for ${scenario.label}`,
			);
			assert.deepEqual(
				plain(pipeline.session.buildSessionContext(resumed.getEntries()).messages.map((message) => message.role)),
				["user", "assistant"],
				`model context follows the stored entry order for ${scenario.label}`,
			);
		}

		assert.equal(fs.readFileSync(migratedPath, "utf8"), scenario.content, `reading keeps bytes for ${scenario.label}`);
	}
});

stage("collisions keep both copies of the data", async () => {
	assert.ok(fs.existsSync(paths.preexistingPath), "pre-existing target kept");
	assert.equal(fs.readFileSync(paths.preexistingPath, "utf8"), preexistingContent, "pre-existing bytes not overwritten");
	assert.equal(
		readIfPresent(path.join(agentDir, COLLISION_SOURCE)),
		scenarios[0].content,
		"colliding legacy source stays in the agent root",
	);

	const ids = plain((await pipeline.session.SessionManager.list(combined.cwd)).map((info) => info.id)).sort();
	assert.deepEqual(ids, [PREEXISTING_ID, combined.id].sort(), "both sessions remain readable after the collision");
});

stage("repeated migration is safe and idempotent", () => {
	const before = new Map();
	for (const scenario of scenarios) {
		const migratedPath = path.join(sessionsRoot, sessionDirName(scenario.cwd), scenario.fileName);
		assert.ok(fs.existsSync(migratedPath), `migrated file present before re-run for ${scenario.label}`);
		before.set(migratedPath, fs.readFileSync(migratedPath, "utf8"));
	}
	const beforePreexisting = fs.readFileSync(paths.preexistingPath, "utf8");

	assert.equal(pipeline.migration.migrateSessionsFromAgentRoot(), undefined, "second migration run completes");
	assert.equal(pipeline.migration.migrateSessionsFromAgentRoot(), undefined, "third migration run completes");

	for (const [migratedPath, content] of before) {
		assert.ok(fs.existsSync(migratedPath), "migrated file survives re-runs");
		assert.equal(fs.readFileSync(migratedPath, "utf8"), content, `re-runs keep bytes for ${path.basename(migratedPath)}`);
	}
	for (const scenario of scenarios) {
		assert.equal(
			readIfPresent(path.join(agentDir, scenario.fileName)),
			undefined,
			`re-runs do not duplicate legacy files for ${scenario.label}`,
		);
	}
	assert.deepEqual(fs.readdirSync(sessionsRoot).sort(), expectedSessionDirs(), "re-runs create no extra directories");
	assert.equal(fs.readFileSync(paths.preexistingPath, "utf8"), beforePreexisting, "collision target survives re-runs");
	assert.equal(readIfPresent(path.join(agentDir, COLLISION_SOURCE)), scenarios[0].content, "collision source survives re-runs");
	assert.equal(readIfPresent(path.join(agentDir, MALFORMED_HEADER)), malformedHeaderContent, "malformed header untouched");
	assert.equal(readIfPresent(path.join(agentDir, MISSING_CWD)), missingCwdContent, "cwd-less session untouched");
});

try {
	// Deterministic sequencing: each stage starts only after the previous promise
	// settles, so no timers or clock-based waits are used anywhere.
	await stages.reduce(
		(previous, { name, run }) =>
			previous.then(async () => {
				try {
					await run();
				} catch (error) {
					error.message = `[stage: ${name}] ${error.message}`;
					throw error;
				}
			}),
		Promise.resolve(),
	);
} finally {
	fs.rmSync(sandbox, { recursive: true, force: true });
}
