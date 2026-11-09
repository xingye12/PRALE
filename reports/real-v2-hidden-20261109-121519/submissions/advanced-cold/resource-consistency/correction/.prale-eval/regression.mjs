#!/usr/bin/env node
/**
 * Cross-module regression for the project-trust / settings / resource-loader incident.
 *
 * Real submitted modules are linked by subject.mjs:
 *   project-trust.ts -> resource-loader.ts -> settings-manager.ts -> package-manager fake
 * Only external boundaries (storage, extension event delivery, UI, package resolution,
 * extension loading) are faked. All assertions use node:assert/strict and are left
 * uncaught so a failing behavior exits non-zero.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createResourcePipeline } from "./subject.mjs";

const root = process.cwd();
const projectSettings = { defaultModel: "project-model", extensions: ["project"], compaction: { reserveTokens: 4096 } };
const globalSettings = {
	defaultModel: "global-model",
	extensions: ["global"],
	compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
};

/** Copy a value that may come from the VM realm into plain host objects. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** Values of every recorded event of one type. */
function events(pipeline, type) {
	return plain(pipeline.events.filter((event) => event[0] === type).map((event) => event.slice(1)));
}

/** Deterministically drain promise continuations; no timers or real time involved. */
async function flushMicrotasks(turns = 1000) {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
	}
}

function namesOf(result) {
	return plain(result.extensions.map((extension) => path.basename(extension.path)));
}

function assertStorageUntouched(pipeline, before) {
	assert.equal(pipeline.storageData.global, before.global, "global settings storage must not be rewritten by trust resolution");
	assert.equal(pipeline.storageData.project, before.project, "project settings storage must not be rewritten by trust resolution");
}

// ---------------------------------------------------------------------------
// 1. Untrusted bootstrap -> resolver exactly once -> trust reloads project.
//    A stored approval grants access; the asynchronous gate proves the resolver
//    only starts after the bootstrap pass is complete.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.stored = true;
	const before = { global: pipeline.storageData.global, project: pipeline.storageData.project };

	let releaseResolver;
	const resolverGate = new Promise((resolve) => {
		releaseResolver = resolve;
	});
	let resolverCalls = 0;
	let resolverBootstrapNames;
	const reloadPromise = pipeline.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls += 1;
			resolverBootstrapNames = namesOf(extensionsResult);
			await resolverGate;
			// The real cross-module resolver consumes the bootstrap result.
			return pipeline.resolve(extensionsResult);
		},
	});

	// The resolver body is held on resolverGate. Drain only promise continuations so
	// the bootstrap pass can finish and reach the resolver without any wall clock.
	await flushMicrotasks();

	assert.equal(resolverCalls, 1, "the resolver must run exactly once after the untrusted bootstrap");
	assert.deepEqual(
		events(pipeline, "resolve"),
		[[false, "global-model"]],
		"the bootstrap resource resolution must see an untrusted project and global settings only",
	);
	assert.deepEqual(
		events(pipeline, "load"),
		[[["cli.ts", "global.ts"]]],
		"bootstrap must load user/CLI extensions only",
	);
	assert.deepEqual(resolverBootstrapNames, ["cli.ts", "global.ts"], "resolver must receive the untrusted bootstrap extension set");
	assert.equal(events(pipeline, "extension-decision").length, 0, "the final trust decision is still pending at the gate");
	assert.equal(pipeline.settings.isProjectTrusted(), false, "bootstrap must leave the project untrusted");
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {}, "bootstrap must not expose project settings");
	assert.equal(pipeline.consentWrites.length, 0, "a stored decision is reused without writing consent");

	releaseResolver();
	await reloadPromise;

	assert.equal(resolverCalls, 1, "the resolver must not run a second time during final loading");
	assert.equal(events(pipeline, "extension-decision").length, 1, "extension decision evaluated once");
	assert.deepEqual(
		events(pipeline, "resolve"),
		[
			[false, "global-model"],
			[true, "project-model"],
		],
		"after trust, resources resolve against project settings",
	);
	assert.deepEqual(
		namesOf(pipeline.loader.getExtensions()),
		["cli.ts", "global.ts", "project.ts"],
		"trusted final loading adds project extensions to the reused bootstrap set",
	);
	assert.deepEqual(
		events(pipeline, "load"),
		[[["cli.ts", "global.ts"]], [["project.ts"]]],
		"already-loaded user/CLI extensions are reused instead of re-executed",
	);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), projectSettings);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(plain(pipeline.settings.getGlobalSettings()), globalSettings);
	assertStorageUntouched(pipeline, before);
}

// ---------------------------------------------------------------------------
// 2. Denial: the same pipeline must keep the project untrusted and unloaded.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.stored = false;
	const before = { global: pipeline.storageData.global, project: pipeline.storageData.project };

	const result = await pipeline.reload();

	assert.equal(result.calls, 1, "denial still resolves trust exactly once");
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"], "a denied project must not load project extensions");
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(
		events(pipeline, "resolve"),
		[
			[false, "global-model"],
			[false, "global-model"],
		],
		"both bootstrap and final resolution stay untrusted after denial",
	);
	assert.equal(pipeline.consentWrites.length, 0, "reusing a stored denial must not rewrite consent");
	assertStorageUntouched(pipeline, before);
}

// ---------------------------------------------------------------------------
// 3. Extension approval without `remember` is session-only.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.extension = { trusted: "yes" };
	const before = { global: pipeline.storageData.global, project: pipeline.storageData.project };

	const result = await pipeline.reload();

	assert.equal(result.calls, 1);
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts", "project.ts"], "session-only approval must grant access now");
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(pipeline.consentWrites, [], "an extension decision without remember must not persist consent");
	assert.equal(events(pipeline, "extension-decision").length, 1);
	assertStorageUntouched(pipeline, before);
}

// ---------------------------------------------------------------------------
// 4. Extension denial with an explicit `remember: false` is also session-only.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.extension = { trusted: "no", remember: false };
	const before = { global: pipeline.storageData.global, project: pipeline.storageData.project };

	const result = await pipeline.reload();

	assert.equal(result.calls, 1);
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"], "session-only denial must block project extensions");
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
	assert.deepEqual(pipeline.consentWrites, [], "remember: false must not persist consent");
	assertStorageUntouched(pipeline, before);
}

// ---------------------------------------------------------------------------
// 5. Explicit `remember: true` persists both approval and denial.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.extension = { trusted: "yes", remember: true };

	let result = await pipeline.reload();
	assert.equal(result.calls, 1);
	assert.deepEqual(pipeline.consentWrites, [[root, true]], "remember: true persists approval");
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts", "project.ts"]);

	pipeline.scenario.extension = { trusted: "no", remember: true };
	result = await pipeline.reload();
	assert.equal(result.calls, 1);
	assert.deepEqual(
		pipeline.consentWrites,
		[
			[root, true],
			[root, false],
		],
		"remember: true persists denial too",
	);
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"]);
	assert.equal(pipeline.settings.isProjectTrusted(), false);
}

// ---------------------------------------------------------------------------
// 6. SettingsManager trust changes reload/clear project settings immediately.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);

	assert.equal(pipeline.settings.isProjectTrusted(), true, "fixture starts trusted");
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), projectSettings);

	pipeline.settings.setProjectTrusted(false);
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {}, "dropping trust clears project settings");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "global settings remain active untrusted");

	pipeline.settings.setProjectTrusted(true);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), projectSettings, "regaining trust reloads project settings");
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");

	pipeline.settings.setProjectTrusted(false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
	assert.deepEqual(plain(pipeline.settings.getGlobalSettings()), globalSettings, "trust changes never mutate global settings");
}

// ---------------------------------------------------------------------------
// 7. Pre-trust bootstrap is available on its own and never weakens trust.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	const bootstrap = await pipeline.loader.loadProjectTrustExtensions();
	assert.deepEqual(namesOf(bootstrap), ["cli.ts", "global.ts"], "bootstrap exposes only non-project extensions");
	assert.equal(pipeline.settings.isProjectTrusted(), false, "bootstrap leaves the manager untrusted");
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
}

console.log("project-trust regression: all cross-module assertions passed");
