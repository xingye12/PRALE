/**
 * Cross-module regression for advanced/resource-consistency/transfer.
 *
 * Loads the submitted production modules through the read-only `.prale-eval/subject.mjs`
 * helper (real `project-trust.ts`, `settings-manager.ts` and `resource-loader.ts` are
 * executed; only file/provider boundaries are faked) and asserts observable behaviour:
 *
 *   1. project-trust  : a remembered decision (true *or* false) is authoritative and only a
 *                       missing entry falls through to the default policy / prompt path.
 *   2. settings-manager: project values override global values while trusted, nested global
 *                       defaults survive, and an untrusted project contributes nothing.
 *   3. resource-loader:  the accepted decision reaches final resource resolution (project
 *                       settings and project extensions are assembled after approval and are
 *                       withheld after a denial).
 *
 * Every assertion is a `node:assert/strict` assertion; the script imports no test framework
 * and fails with a non-zero exit code as soon as a regression is present. No wall-clock time,
 * randomness or external service is used as evidence: asynchronous ordering is driven by
 * explicit promises.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGraph, createResourcePipeline } from "./subject.mjs";

const root = process.cwd();
const fixtureDir = join(root, ".prale-eval", ".tmp-regression-fixtures");

/* ------------------------------------------------------------------ fixtures */
// Local inputs live under `.prale-eval/` and are always removed again. They mirror the
// in-memory storage used by the pipeline below so the intended precedence is self-describing.
const GLOBAL_FIXTURE = {
	defaultModel: "global-model",
	extensions: ["global"],
	compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
};
const PROJECT_FIXTURE = {
	defaultModel: "project-model",
	extensions: ["project"],
	compaction: { reserveTokens: 4096 },
};

function writeFixtures() {
	rmSync(fixtureDir, { recursive: true, force: true });
	mkdirSync(fixtureDir, { recursive: true });
	writeFileSync(join(fixtureDir, "global.settings.json"), JSON.stringify(GLOBAL_FIXTURE));
	writeFileSync(join(fixtureDir, "project.settings.json"), JSON.stringify(PROJECT_FIXTURE));
	const global = JSON.parse(readFileSync(join(fixtureDir, "global.settings.json"), "utf8"));
	const project = JSON.parse(readFileSync(join(fixtureDir, "project.settings.json"), "utf8"));
	// The project file overrides one nested key and must inherit the other one from global.
	assert.equal(project.defaultModel, "project-model");
	assert.equal(project.compaction.keepRecentTokens, undefined);
	assert.equal(global.compaction.keepRecentTokens, 2000);
	assert.equal(global.compaction.reserveTokens, 8192);
}

/* ------------------------------------------------- 1. project-trust resolution */
// A dedicated graph keeps the trust resolver's own dependencies (extension hook, trust
// option catalog, trust-requiring-resource probe) observable and fully deterministic.
async function trustModule() {
	const state = {
		emit: async () => ({ result: undefined, errors: [] }),
		options: [{ label: "Approve", trusted: true, updates: [{ path: "/fixture", decision: true }] }],
		selected: "Approve",
		selectCalls: 0,
		recordedErrors: [],
	};
	const graph = createGraph(root, {
		APP_NAME: "pi",
		CONFIG_DIR_NAME: ".pi",
		emitProjectTrustEvent: (...args) => state.emit(...args),
		getProjectTrustOptions: () => state.options,
		hasTrustRequiringProjectResources: () => true,
	});
	const { resolveProjectTrusted } = await graph.module("project");
	return { resolveProjectTrusted, state };
}

/** Deep structures produced inside the VM context have that context's prototypes. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function trustStore(decision, writes) {
	return {
		get: () => decision,
		set: (...args) => writes.push(["set", ...args]),
		setMany: (...args) => writes.push(["setMany", ...args]),
	};
}

function trustContext(state, hasUI) {
	return {
		hasUI,
		ui: {
			select: async () => {
				state.selectCalls += 1;
				return state.selected;
			},
		},
	};
}

async function assertTrustResolution() {
	const { resolveProjectTrusted, state } = await trustModule();
	const resolve = (options) =>
		resolveProjectTrusted({
			cwd: "/fixture",
			projectTrustContext: trustContext(state, options.hasUI ?? false),
			...options,
		});

	// A remembered denial is authoritative: the allow-by-default policy must not resurrect it.
	const denialWrites = [];
	assert.equal(
		await resolve({ trustStore: trustStore(false, denialWrites), defaultProjectTrust: "always" }),
		false,
		"a stored denial must not fall through to defaultProjectTrust=always",
	);
	assert.deepEqual(denialWrites, [], "a remembered denial must not be rewritten by resolution");

	// A remembered approval is equally authoritative, even under an allow-nothing policy.
	assert.equal(await resolve({ trustStore: trustStore(true, []), defaultProjectTrust: "never" }), true);

	// Only a missing entry reaches the policy.
	assert.equal(await resolve({ trustStore: trustStore(null, []), defaultProjectTrust: "always" }), true);
	assert.equal(await resolve({ trustStore: trustStore(undefined, []), defaultProjectTrust: "never" }), false);
	assert.equal(await resolve({ trustStore: trustStore(null, []), defaultProjectTrust: "ask" }), false);

	// An explicit override still wins over both the store and the policy.
	assert.equal(
		await resolve({ trustStore: trustStore(false, []), trustOverride: true, defaultProjectTrust: "never" }),
		true,
	);
	assert.equal(
		await resolve({ trustStore: trustStore(true, []), trustOverride: false, defaultProjectTrust: "always" }),
		false,
	);

	// Without UI the "ask" policy denies; with UI the selected option is persisted through the
	// trust store and its decision is returned.
	const promptWrites = [];
	const callsBeforePrompt = state.selectCalls;
	assert.equal(
		await resolve({ trustStore: trustStore(null, promptWrites), defaultProjectTrust: "ask", hasUI: true }),
		true,
	);
	assert.equal(state.selectCalls, callsBeforePrompt + 1);
	assert.deepEqual(promptWrites, [["setMany", [{ path: "/fixture", decision: true }]]]);

	// A remembered denial short-circuits the prompt: the user is not asked again and the UI
	// decision cannot override the stored one.
	const deniedPromptWrites = [];
	const callsBeforeDenial = state.selectCalls;
	assert.equal(
		await resolve({ trustStore: trustStore(false, deniedPromptWrites), defaultProjectTrust: "ask", hasUI: true }),
		false,
	);
	assert.equal(state.selectCalls, callsBeforeDenial, "a stored denial must not prompt again");
	assert.deepEqual(deniedPromptWrites, []);

	// An extension decision is awaited before any fallback is considered, and it is remembered
	// when the extension asks for it.
	let releaseHook;
	const hookGate = new Promise((resolveGate) => {
		releaseHook = resolveGate;
	});
	const order = [];
	state.emit = async () => {
		order.push("hook-start");
		await hookGate;
		order.push("hook-end");
		return { result: { trusted: "yes", remember: true }, errors: [] };
	};
	const extensionWrites = [];
	let settled = false;
	const pending = resolve({
		trustStore: trustStore(false, extensionWrites),
		defaultProjectTrust: "never",
		extensionsResult: { extensions: [], errors: [] },
	});
	pending.then(() => {
		settled = true;
		order.push("settled");
	});
	await Promise.resolve();
	assert.equal(settled, false, "resolution must await the extension hook");
	assert.deepEqual(order, ["hook-start"]);
	releaseHook();
	assert.equal(await pending, true, "the awaited extension decision must reach the caller");
	assert.deepEqual(order, ["hook-start", "hook-end", "settled"]);
	assert.deepEqual(extensionWrites, [["set", "/fixture", true]], "a remembered extension decision is stored");

	// Extension errors are reported to the caller's diagnostics sink without changing the outcome.
	state.emit = async () => ({
		result: { trusted: "no", remember: false },
		errors: [{ extensionPath: "/fixture/ext.ts", error: "boom" }],
	});
	assert.equal(
		await resolve({
			trustStore: trustStore(null, []),
			defaultProjectTrust: "always",
			extensionsResult: { extensions: [], errors: [] },
			onExtensionError: (message) => state.recordedErrors.push(message),
		}),
		false,
		"an explicit extension denial must be honoured",
	);
	assert.deepEqual(state.recordedErrors, ['Extension "/fixture/ext.ts" project_trust error: boom']);
}

/* ------------------------------------------------ 2. settings merge precedence */
async function assertSettingsPrecedence() {
	const pipeline = await createResourcePipeline(root);
	const settings = pipeline.settings;

	// Trusted: project values override global values, including nested keys.
	assert.equal(settings.isProjectTrusted(), true);
	assert.equal(settings.getDefaultModel(), "project-model", "project settings must override global settings");
	assert.deepEqual(plain(settings.getCompactionSettings()), {
		enabled: true,
		reserveTokens: 4096,
		keepRecentTokens: 2000,
	});
	assert.equal(settings.getCompactionReserveTokens(), 4096);
	assert.equal(settings.getCompactionKeepRecentTokens(), 2000, "nested global defaults must survive");
	assert.deepEqual(plain(settings.getExtensionPaths()), ["project"], "arrays are replaced, not concatenated");

	// Global values are still intact and readable on their own.
	assert.deepEqual(settings.getGlobalSettings(), GLOBAL_FIXTURE);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), PROJECT_FIXTURE);

	// Untrusted: the project contributes nothing and the global defaults stand alone.
	settings.setProjectTrusted(false);
	assert.equal(settings.isProjectTrusted(), false);
	assert.equal(settings.getDefaultModel(), "global-model");
	assert.deepEqual(plain(settings.getProjectSettings()), {});
	assert.deepEqual(plain(settings.getCompactionSettings()), {
		enabled: true,
		reserveTokens: 8192,
		keepRecentTokens: 2000,
	});
	await settings.reload();
	assert.equal(settings.getDefaultModel(), "global-model", "reloading must not resurrect project settings");

	// Re-trusting must restore project precedence (freshly loaded from storage).
	settings.setProjectTrusted(true);
	assert.equal(settings.isProjectTrusted(), true);
	assert.equal(settings.getDefaultModel(), "project-model");
	assert.deepEqual(plain(settings.getCompactionSettings()), {
		enabled: true,
		reserveTokens: 4096,
		keepRecentTokens: 2000,
	});

	// Session overrides sit on top of the merged view, and a reload drops them again.
	settings.applyOverrides({ defaultModel: "override-model", compaction: { reserveTokens: 1024 } });
	assert.equal(settings.getDefaultModel(), "override-model");
	assert.deepEqual(plain(settings.getCompactionSettings()), {
		enabled: true,
		reserveTokens: 1024,
		keepRecentTokens: 2000,
	});
	await settings.reload();
	assert.equal(settings.getDefaultModel(), "project-model");
}

/* --------------------------------- 3. resource-loader trust propagation (end to end) */
async function assertResourceAssembly() {
	const pipeline = await createResourcePipeline(root);
	const basenames = (names) => [...names].sort();

	// Approved project: the resolved decision must reach settings reload *and* resource assembly.
	pipeline.scenario.stored = true;
	pipeline.scenario.policy = "ask";
	const approved = await pipeline.reload();
	assert.equal(approved.calls, 1, "trust is resolved exactly once per reload");
	assert.equal(pipeline.settings.isProjectTrusted(), true, "an approved decision must be applied");
	assert.deepEqual(basenames(approved.names), ["cli.ts", "global.ts", "project.ts"]);
	assert.equal(pipeline.loader.getExtensions().extensions.length, 3);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model", "project settings must apply after approval");

	const resolves = pipeline.events.filter((event) => event[0] === "resolve");
	assert.deepEqual(plain(resolves), [
		["resolve", false, "global-model"],
		["resolve", true, "project-model"],
	]);
	const trustEvents = pipeline.events.map((event) => event[0]);
	assert.deepEqual(trustEvents.slice(-3), ["storage", "resolve", "load"], "resources resolve after the settings reload");

	// Remembered denial under an allow-by-default policy: nothing project-scoped is assembled.
	pipeline.scenario.stored = false;
	pipeline.scenario.policy = "always";
	pipeline.scenario.hasUI = true;
	const denied = await pipeline.reload();
	assert.equal(denied.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), false, "a remembered denial must stay denied");
	assert.deepEqual(basenames(denied.names), ["cli.ts", "global.ts"]);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	const lastResolve = pipeline.events.filter((event) => event[0] === "resolve").at(-1);
	assert.deepEqual(lastResolve, ["resolve", false, "global-model"]);

	// A fresh denial reported by the extension hook is remembered and applied.
	pipeline.scenario.stored = null;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.extension = { trusted: "no", remember: true };
	const remembered = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(basenames(remembered.names), ["cli.ts", "global.ts"]);
	assert.deepEqual(pipeline.consentWrites.at(-1), [root, false], "the denial is stored for later reloads");

	// The remembered denial is honoured by later reloads even with the prompt available.
	pipeline.scenario.stored = false;
	pipeline.scenario.extension = undefined;
	const later = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(basenames(later.names), ["cli.ts", "global.ts"]);
}

/* --------------------------------------------------------------------- runner */
writeFixtures();
try {
	await assertTrustResolution();
	await assertSettingsPrecedence();
	await assertResourceAssembly();
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}
assert.equal(existsSync(fixtureDir), false, "temporary fixtures must be cleaned up");

console.log("resource-consistency regression: passed (project-trust, settings-manager, resource-loader)");
