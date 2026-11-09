/**
 * Regression coverage for "Untrusted startup leaks project configuration".
 *
 * Loads the submitted production modules through the read-only subject helper so
 * that the real SettingsManager, DefaultResourceLoader and resolveProjectTrusted
 * implementations run against each other. Only external IO/provider boundaries
 * are faked by the helper.
 *
 * Node 24: `node --experimental-vm-modules .prale-eval/regression.mjs`
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createResourcePipeline } from "./subject.mjs";

// Modules are loaded from the workspace root by the subject helper.
const root = process.cwd();
// Local test inputs live under .prale-eval and are removed again on every run.
const fixtureDir = path.resolve(".prale-eval/tmp");
const globalSettingsFile = path.join(fixtureDir, "global-settings.json");
const projectSettingsFile = path.join(fixtureDir, "project-settings.json");

function resetFixtureRoot() {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	fs.mkdirSync(fixtureDir, { recursive: true });
	fs.writeFileSync(
		globalSettingsFile,
		JSON.stringify({ defaultModel: "global-model", compaction: { reserveTokens: 8192, keepRecentTokens: 2000 } }),
	);
	fs.writeFileSync(
		projectSettingsFile,
		JSON.stringify({ defaultModel: "project-model", compaction: { reserveTokens: 4096 } }),
	);
}

// Values produced inside the vm context use that realm's prototypes, and
// deepStrictEqual compares prototypes, so copy them into plain host values.
const plain = (value) => JSON.parse(JSON.stringify(value));
const names = (values) => Array.from(values, (value) => path.basename(value));
const resolveEvents = (pipeline) => pipeline.events.filter((event) => event[0] === "resolve");
const loadEvents = (pipeline) => pipeline.events.filter((event) => event[0] === "load");
const hasEvent = (pipeline, type) => pipeline.events.some((event) => event[0] === type);

async function bootstrapSeesOnlyGlobalConfiguration() {
	const pipeline = await createResourcePipeline(root);

	// Direct bootstrap entry point used by the CLI before any trust decision.
	const preTrust = await pipeline.loader.loadProjectTrustExtensions();

	assert.deepEqual(
		names(Array.from(preTrust.extensions, (extension) => extension.path)),
		["cli.ts", "global.ts"],
		"bootstrap must load only CLI/global extensions, never project extensions",
	);
	assert.deepEqual(
		resolveEvents(pipeline),
		[["resolve", false, "global-model"]],
		"bootstrap package resolution must run with project settings excluded",
	);
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {}, "untrusted bootstrap must not read project settings");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "bootstrap must see global configuration only");
	assert.deepEqual(
		plain(pipeline.settings.getCompactionSettings()),
		{ enabled: true, reserveTokens: 8192, keepRecentTokens: 2000 },
		"untrusted bootstrap must keep global nested settings",
	);

	// The same boundary through the full reload pipeline: the pre-trust extension
	// set handed to the trust resolver and the package resolution that produced it
	// must not contain project resources.
	pipeline.events.length = 0;
	const untrustedReload = await pipeline.reload();
	assert.equal(untrustedReload.calls, 1);
	assert.deepEqual(plain(untrustedReload.names), ["cli.ts", "global.ts"]);
	assert.deepEqual(resolveEvents(pipeline), [
		["resolve", false, "global-model"],
		["resolve", false, "global-model"],
	]);
	assert.deepEqual(names(loadEvents(pipeline).flatMap((event) => event[1])), ["cli.ts", "global.ts"]);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), {});
}

async function trustedReloadAdmitsProjectResources() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.stored = true;

	// The process is already trusted, but a fresh bootstrap must still begin from
	// global configuration before the trust resolver runs again.
	const reloaded = await pipeline.reload();
	assert.equal(reloaded.calls, 1);
	assert.deepEqual(
		resolveEvents(pipeline),
		[
			["resolve", false, "global-model"],
			["resolve", true, "project-model"],
		],
		"bootstrap must read global configuration first, trusted reload afterwards admits project settings",
	);
	assert.deepEqual(plain(reloaded.names), ["cli.ts", "global.ts", "project.ts"]);

	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(
		plain(pipeline.settings.getCompactionSettings()),
		{ enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 },
		"trusted reload must merge nested project settings over inherited global ones",
	);
	assert.equal(pipeline.settings.getGlobalSettings().compaction.keepRecentTokens, 2000);
}

async function explicitFalseOverrideWinsWithoutPrompting() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = false;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.stored = null;

	// An extension that would approve trust must never be consulted when the
	// caller passed an explicit override.
	pipeline.scenario.extension = { trusted: "yes" };
	const withExtension = await pipeline.resolve({ extensions: [], errors: [], runtime: {} });
	assert.equal(withExtension, false, "explicit --project-trust=false must win over an approving extension");
	assert.equal(hasEvent(pipeline, "extension-decision"), false, "explicit override must not run the trust prompt/extension");
	assert.equal(pipeline.consentWrites.length, 0, "explicit override must not persist consent");

	// Even with an interactive UI available the explicit false override must not prompt.
	pipeline.scenario.extension = undefined;
	pipeline.events.length = 0;
	const withUI = await pipeline.resolve({ extensions: [], errors: [], runtime: {} });
	assert.equal(withUI, false, "explicit false override must not be replaced by an interactive approval");
	assert.equal(pipeline.consentWrites.length, 0);

	// A positive override short-circuits as well.
	pipeline.scenario.override = true;
	const forced = await pipeline.resolve(undefined);
	assert.equal(forced, true);
	assert.equal(hasEvent(pipeline, "extension-decision"), false);

	// End to end: an explicit false override keeps project resources out.
	const overridden = await createResourcePipeline(root);
	overridden.scenario.override = false;
	overridden.scenario.hasUI = true;
	const reloaded = await overridden.reload();
	assert.deepEqual(plain(reloaded.names), ["cli.ts", "global.ts"]);
	assert.deepEqual(resolveEvents(overridden), [
		["resolve", false, "global-model"],
		["resolve", false, "global-model"],
	]);
	assert.equal(overridden.settings.getDefaultModel(), "global-model");
	assert.deepEqual(plain(overridden.settings.getProjectSettings()), {});
	assert.equal(hasEvent(overridden, "extension-decision"), false);
}

async function settingsManagerRespectsTrustAndNestedInheritance() {
	const pipeline = await createResourcePipeline(root);
	const { SettingsManager } = await pipeline.graph.module("settings");
	const data = {
		global: fs.readFileSync(globalSettingsFile, "utf-8"),
		project: fs.readFileSync(projectSettingsFile, "utf-8"),
	};
	const scopesRead = [];
	const storage = {
		withLock(scope, fn) {
			scopesRead.push(scope);
			const next = fn(data[scope]);
			if (next !== undefined) data[scope] = next;
		},
	};

	const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
	assert.deepEqual(plain(manager.getProjectSettings()), {}, "untrusted manager must not parse project settings");
	assert.equal(manager.getDefaultModel(), "global-model");
	assert.deepEqual(plain(manager.getCompactionSettings()), {
		enabled: true,
		reserveTokens: 8192,
		keepRecentTokens: 2000,
	});

	manager.setProjectTrusted(true);
	assert.equal(manager.getDefaultModel(), "project-model");
	assert.deepEqual(
		plain(manager.getCompactionSettings()),
		{ enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 },
		"nested global values must survive a project override",
	);

	await manager.reload();
	assert.equal(manager.getDefaultModel(), "project-model");

	manager.setProjectTrusted(false);
	await manager.reload();
	assert.deepEqual(plain(manager.getProjectSettings()), {}, "reload while untrusted must drop project settings again");
	assert.equal(manager.getDefaultModel(), "global-model");
}

async function main() {
	resetFixtureRoot();
	try {
		await bootstrapSeesOnlyGlobalConfiguration();
		await trustedReloadAdmitsProjectResources();
		await explicitFalseOverrideWinsWithoutPrompting();
		await settingsManagerRespectsTrustAndNestedInheritance();
		console.log("resource consistency regression: all assertions passed");
	} finally {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
}

await main();
