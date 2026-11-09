/**
 * End-to-end regression for the untrusted-startup boundary.
 *
 * Loads the submitted production modules through `.prale-eval/subject.mjs` so that
 * the real resource loader, the real settings manager and the real project-trust
 * resolver are exercised together. Only external IO/provider boundaries (package
 * manager, extension loading, trust-prompt UI, trust store, settings storage) are
 * substituted by the subject helper.
 *
 * Scenarios assert:
 *   1. a fresh bootstrap reads global/CLI configuration only,
 *   2. an explicit `false` (and `true`) override wins without prompting,
 *   3. persisted decisions still apply and defaults/no-UI behaviour is unchanged,
 *   4. a later trusted reload admits project resources while keeping global/CLI
 *      resources and recursive nested-settings inheritance intact,
 *   5. the settings manager never touches project storage before consent.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createResourcePipeline } from "./subject.mjs";

const root = process.cwd();
/** Modules run in their own VM realm, so cross-realm arrays/objects are normalized before comparing. */
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const basenames = (result) => plain(result.extensions).map((extension) => path.basename(extension.path));
const ofKind = (pipeline, kind) => pipeline.events.filter((event) => event[0] === kind);
const scopes = (pipeline) => pipeline.events.filter((event) => event[0] === "storage").map((event) => event[1]);

const GLOBAL_SETTINGS = {
	defaultModel: "global-model",
	extensions: ["global"],
	compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
};
const PROJECT_SETTINGS = {
	defaultModel: "project-model",
	extensions: ["project"],
	compaction: { reserveTokens: 4096 },
};

function memoryStorage(globalJson, projectJson) {
	const state = { data: { global: globalJson, project: projectJson }, reads: [] };
	return {
		state,
		withLock(scope, fn) {
			state.reads.push(scope);
			const next = fn(state.data[scope]);
			if (next !== undefined) state.data[scope] = next;
		},
	};
}

function trustStore(initial) {
	const store = {
		value: initial,
		writes: [],
		get() {
			return store.value;
		},
		set(...args) {
			store.writes.push(args);
			store.value = args[1];
		},
		setMany(...args) {
			store.writes.push(args);
		},
	};
	return store;
}

/** Project-trust resolver seen through the loader/settings modules it belongs to. */
async function directTrustChecks(pipeline) {
	const project = await pipeline.graph.module("project");
	let prompts = 0;
	const select = async () => {
		prompts += 1;
		return "approve once";
	};
	const store = trustStore(true);
	const base = {
		cwd: root,
		trustStore: store,
		defaultProjectTrust: "always",
		projectTrustContext: { hasUI: true, ui: { select } },
	};

	// An explicit `false` override must win over a trusted store entry, a permissive
	// default and an available UI prompt.
	assert.equal(await project.resolveProjectTrusted({ ...base, trustOverride: false }), false);
	assert.equal(prompts, 0, "explicit false override must not prompt");
	assert.deepEqual(store.writes, [], "explicit false override must not persist a decision");

	// An explicit `true` override must win over an untrusted store and a "never" default.
	store.value = false;
	assert.equal(
		await project.resolveProjectTrusted({
			...base,
			trustOverride: true,
			defaultProjectTrust: "never",
			projectTrustContext: { hasUI: false, ui: { select } },
		}),
		true,
	);
	assert.equal(prompts, 0, "explicit true override must not prompt");

	// Persisted decisions still apply and never prompt.
	store.value = true;
	assert.equal(await project.resolveProjectTrusted({ ...base, defaultProjectTrust: "never" }), true);
	assert.equal(prompts, 0, "remembered trust must not prompt");
	store.value = false;
	assert.equal(await project.resolveProjectTrusted({ ...base, defaultProjectTrust: "always" }), false);
	assert.equal(prompts, 0, "remembered distrust must not prompt");

	// Unknown state with a UI still asks exactly once.
	store.value = null;
	assert.equal(await project.resolveProjectTrusted({ ...base, defaultProjectTrust: "ask" }), true);
	assert.equal(prompts, 1, "unknown state with UI asks once");

	// Unknown state without a UI stays untrusted without prompting.
	store.value = null;
	assert.equal(
		await project.resolveProjectTrusted({
			...base,
			defaultProjectTrust: "ask",
			projectTrustContext: { hasUI: false, ui: { select } },
		}),
		false,
	);
	assert.equal(prompts, 1, "no UI means no prompt");
	console.log("ok - explicit and persisted trust overrides win without prompting");
}

/** Fresh bootstrap: only global + CLI resources, no project settings/storage access. */
async function bootstrapOnlyGlobalChecks() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = false;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = "always";
	pipeline.scenario.stored = true;
	assert.equal(pipeline.settings.isProjectTrusted(), true, "fixture starts from a trusted-looking manager");

	pipeline.events.length = 0;
	const result = await pipeline.reload();

	assert.equal(result.calls, 1, "trust resolution runs exactly once per reload");
	assert.deepEqual(
		plain(ofKind(pipeline, "resolve").map((event) => event.slice(1))),
		[
			[false, "global-model"],
			[false, "global-model"],
		],
		"bootstrap and final pass both read global configuration only",
	);
	assert.deepEqual(
		plain(ofKind(pipeline, "load")[0][1]),
		["cli.ts", "global.ts"],
		"bootstrap loads global + CLI extensions only",
	);
	assert.ok(
		!scopes(pipeline).includes("project"),
		"untrusted bootstrap must not read or write project settings storage",
	);
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"], "global and CLI resources survive an untrusted reload");
	assert.deepEqual(
		basenames(pipeline.loader.getExtensions()),
		["cli.ts", "global.ts"],
		"the published extension set holds global + CLI resources only",
	);
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {}, "project settings stay unread before consent");
	assert.deepEqual(plain(pipeline.consentWrites), [], "an explicit override writes nothing to the trust store");
	assert.deepEqual(
		plain(pipeline.settings.getCompactionSettings()),
		{ enabled: true, reserveTokens: 8192, keepRecentTokens: 2000 },
		"global nested compaction settings are preserved",
	);
	assert.deepEqual(plain(pipeline.settings.getGlobalSettings().extensions), ["global"]);
	console.log("ok - bootstrap reads only global configuration and never touches project storage");
}

/** Bare interactive run with an explicit false override: nothing project-local appears. */
async function explicitFalseWithoutStoredDecisionChecks() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = false;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.stored = null;

	pipeline.events.length = 0;
	const result = await pipeline.reload();

	assert.deepEqual(
		plain(ofKind(pipeline, "resolve").map((event) => event.slice(1))),
		[
			[false, "global-model"],
			[false, "global-model"],
		],
		"explicit false override keeps every settings read global",
	);
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"], "explicit false override excludes project resources");
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
	assert.deepEqual(plain(pipeline.consentWrites), []);
	console.log("ok - explicit false override is honoured instead of prompting");
}

/** Trusted reload later admits project resources; nested inheritance merges recursively. */
async function trustedReloadAdmitsProjectChecks() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = undefined;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.stored = true;

	pipeline.events.length = 0;
	const result = await pipeline.reload();

	assert.deepEqual(
		plain(ofKind(pipeline, "resolve").map((event) => event.slice(1))),
		[
			[false, "global-model"],
			[true, "project-model"],
		],
		"bootstrap stays untrusted, the reload after consent is trusted",
	);
	assert.deepEqual(
		plain(ofKind(pipeline, "load")[0][1]),
		["cli.ts", "global.ts"],
		"pre-consent extension set is global + CLI",
	);
	assert.deepEqual(
		plain(result.names),
		["cli.ts", "global.ts", "project.ts"],
		"trusted reload admits the project extension while keeping CLI and global resources",
	);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), PROJECT_SETTINGS);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(
		plain(pipeline.settings.getCompactionSettings()),
		{ enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 },
		"project overrides only its nested key and inherits the global sibling",
	);
	assert.deepEqual(
		plain(pipeline.settings.getGlobalSettings()),
		GLOBAL_SETTINGS,
		"global configuration is untouched by the trusted reload",
	);
	assert.deepEqual(
		plain(ofKind(pipeline, "load").map((event) => event[1])),
		[["cli.ts", "global.ts"], ["project.ts"]],
		"only the newly admitted project extension is loaded after consent; the pre-trust runtime is reused",
	);
	assert.deepEqual(plain(pipeline.consentWrites), [], "a remembered decision needs no new prompt");
	assert.equal(ofKind(pipeline, "extension-decision").length, 1, "extensions get exactly one trust decision");
	console.log("ok - trusted reload admits project resources and preserves global/CLI resources + nested inheritance");
}

/** Loader bootstrap entry point used by the CLI must demote an already-trusted manager. */
async function loaderBootstrapEntryChecks() {
	const pipeline = await createResourcePipeline(root);
	assert.equal(pipeline.settings.isProjectTrusted(), true, "fixture starts from a trusted-looking manager");

	pipeline.events.length = 0;
	const preTrust = await pipeline.loader.loadProjectTrustExtensions();

	assert.equal(pipeline.settings.isProjectTrusted(), false, "bootstrap forces the untrusted state");
	assert.deepEqual(basenames(preTrust), ["cli.ts", "global.ts"], "pre-trust extensions exclude project extensions");
	assert.deepEqual(plain(preTrust.errors), []);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
	assert.deepEqual(
		plain(ofKind(pipeline, "resolve").map((event) => event.slice(1))),
		[[false, "global-model"]],
		"bootstrap resolves configuration with project trust disabled",
	);
	assert.ok(!scopes(pipeline).includes("project"), "bootstrap performs no project settings IO");
	assert.deepEqual(
		plain(pipeline.loader.getExtensions().extensions),
		[],
		"bootstrap result is handed to the trust resolver, not published",
	);
	console.log("ok - loadProjectTrustExtensions forces global-only configuration");
}

/** Settings manager alone: no project reads before consent, recursive merge after. */
async function settingsManagerTrustChecks() {
	const pipeline = await createResourcePipeline(root);
	const { SettingsManager } = await pipeline.graph.module("settings");

	const storage = memoryStorage(JSON.stringify(GLOBAL_SETTINGS), JSON.stringify(PROJECT_SETTINGS));
	const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });

	assert.equal(manager.isProjectTrusted(), false);
	assert.deepEqual(plain(manager.getProjectSettings()), {});
	assert.equal(manager.getDefaultModel(), "global-model");
	assert.deepEqual(plain(manager.getCompactionSettings()), {
		enabled: true,
		reserveTokens: 8192,
		keepRecentTokens: 2000,
	});
	assert.deepEqual(storage.state.reads, ["global"], "untrusted construction reads global settings only");

	await manager.reload();
	assert.deepEqual(plain(manager.getProjectSettings()), {});
	assert.ok(!storage.state.reads.includes("project"), "untrusted reload skips project settings storage");
	assert.deepEqual(plain(manager.getGlobalSettings()), GLOBAL_SETTINGS);

	manager.setProjectTrusted(true);
	assert.equal(manager.isProjectTrusted(), true);
	assert.deepEqual(plain(manager.getProjectSettings()), PROJECT_SETTINGS);
	assert.equal(manager.getDefaultModel(), "project-model");
	assert.deepEqual(
		plain(manager.getCompactionSettings()),
		{ enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 },
		"nested settings merge recursively once trusted",
	);
	assert.deepEqual(plain(manager.getGlobalSettings()), GLOBAL_SETTINGS, "global scope is unchanged by trust promotion");

	manager.setProjectTrusted(false);
	assert.equal(manager.getDefaultModel(), "global-model", "demotion drops project configuration again");
	assert.deepEqual(plain(manager.getProjectSettings()), {});

	const corrupted = memoryStorage(JSON.stringify({ defaultModel: "global-model" }), "{ not json");
	const strict = SettingsManager.fromStorage(corrupted, { projectTrusted: false });
	assert.deepEqual(plain(strict.drainErrors()), [], "untrusted construction never parses the project settings file");
	strict.setProjectTrusted(true);
	assert.equal(strict.getDefaultModel(), "global-model");
	const errors = strict.drainErrors();
	assert.equal(errors.length, 1, "the project settings parse error is reported only after consent");
	assert.equal(errors[0].scope, "project");
	console.log("ok - settings manager gates project IO on trust and merges nested scopes recursively");
}

await directTrustChecks(await createResourcePipeline(root));
await bootstrapOnlyGlobalChecks();
await explicitFalseWithoutStoredDecisionChecks();
await trustedReloadAdmitsProjectChecks();
await loaderBootstrapEntryChecks();
await settingsManagerTrustChecks();
console.log("regression: untrusted-startup boundary holds");
