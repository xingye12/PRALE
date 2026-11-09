#!/usr/bin/env node
/**
 * Cross-module regression for the remembered-denial / configuration-precedence incident.
 *
 * The read-only `subject.mjs` helper links the real submitted modules
 * (project-trust.ts -> settings-manager.ts -> resource-loader.ts) and fakes only
 * external boundaries (settings storage, package manager, extension loading, UI
 * consent, event bus). Every assertion below therefore observes behavior that no
 * single module can satisfy alone:
 *
 *   1. resolver: a stored boolean decision is authoritative (denial must not fall
 *      through to an allow-by-default policy or an interactive prompt);
 *   2. settings: project values override global values only while trusted, and
 *      nested global defaults survive the deep merge;
 *   3. resource assembly: the trust decision returned by the resolver is applied to
 *      the settings manager so approved project resources reach final resolution.
 *
 * No timers, randomness, network, or on-disk fixtures are used; ordering is
 * controlled purely by awaiting promises.
 */
import assert from "node:assert/strict";
import { createResourcePipeline } from "./subject.mjs";

const workspace = process.cwd();

async function newPipeline() {
	return createResourcePipeline(workspace);
}

function resolveEvents(pipeline) {
	return pipeline.events.filter((event) => event[0] === "resolve");
}

// Values produced inside the VM context belong to another realm, so arrays and
// objects are copied into plain host values before strict comparison.
function sorted(values) {
	return [...values].sort();
}

function list(values) {
	return [...values];
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 1. Resolver: a stored boolean is authoritative in both directions.
// ---------------------------------------------------------------------------
{
	const pipeline = await newPipeline();

	pipeline.scenario.stored = false;
	pipeline.scenario.policy = "always";
	pipeline.scenario.hasUI = false;
	assert.equal(
		await pipeline.resolve(undefined),
		false,
		"a stored denial must win over an allow-by-default policy",
	);

	pipeline.scenario.hasUI = true;
	assert.equal(
		await pipeline.resolve(undefined),
		false,
		"a stored denial must not fall through to the interactive consent prompt",
	);
	assert.deepEqual(pipeline.consentWrites, [], "a stored decision must not overwrite trust storage");

	pipeline.scenario.stored = true;
	pipeline.scenario.policy = "never";
	pipeline.scenario.hasUI = false;
	assert.equal(
		await pipeline.resolve(undefined),
		true,
		"a stored approval must win over a deny-by-default policy",
	);

	pipeline.scenario.stored = null;
	pipeline.scenario.policy = "always";
	assert.equal(await pipeline.resolve(undefined), true, "an unset decision must still honour the allow policy");

	pipeline.scenario.policy = "never";
	assert.equal(await pipeline.resolve(undefined), false, "an unset decision must still honour the deny policy");

	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = "ask";
	assert.equal(await pipeline.resolve(undefined), false, "ask without a UI must fail closed");

	console.log("ok 1 resolver: stored boolean decision is authoritative");
}

// ---------------------------------------------------------------------------
// 2. Settings: project precedence while trusted, nested global defaults survive.
// ---------------------------------------------------------------------------
{
	const pipeline = await newPipeline();
	const { settings } = pipeline;

	assert.equal(settings.isProjectTrusted(), true, "pipeline starts trusted");
	assert.equal(settings.getGlobalSettings().defaultModel, "global-model");
	assert.equal(settings.getProjectSettings().defaultModel, "project-model");
	assert.equal(settings.getDefaultModel(), "project-model", "a trusted project scalar must override the global scalar");
	assert.deepEqual(list(settings.getExtensionPaths()), ["project"], "array project values replace global values");

	const compaction = settings.getCompactionSettings();
	assert.equal(compaction.reserveTokens, 4096, "a project nested value must override the global nested value");
	assert.equal(compaction.keepRecentTokens, 2000, "an untouched nested global default must survive the merge");

	settings.setProjectTrusted(false);
	assert.equal(settings.getDefaultModel(), "global-model", "an untrusted project must not contribute values");
	assert.deepEqual(plain(settings.getProjectSettings()), {}, "an untrusted project contributes no settings");
	assert.equal(settings.getCompactionReserveTokens(), 8192, "untrusted reload falls back to the global nested value");
	assert.equal(settings.getCompactionKeepRecentTokens(), 2000, "untrusted reload keeps the global nested default");

	settings.setProjectTrusted(true);
	assert.equal(settings.getDefaultModel(), "project-model", "re-trusting restores project precedence");
	assert.equal(settings.getCompactionReserveTokens(), 4096, "re-trusting restores the project nested value");

	pipeline.storageData.project = JSON.stringify({
		defaultModel: "project-reloaded",
		compaction: { reserveTokens: 1024 },
	});
	await settings.reload();
	assert.equal(settings.getDefaultModel(), "project-reloaded", "reload must pick up project values");
	assert.equal(settings.getCompactionReserveTokens(), 1024, "reload merges the project nested value");
	assert.equal(
		settings.getCompactionKeepRecentTokens(),
		2000,
		"reload keeps the global nested default the project file omits",
	);

	console.log("ok 2 settings: trusted project precedence with surviving nested global defaults");
}

// ---------------------------------------------------------------------------
// 3. Resource assembly: the approved decision reaches final resource resolution.
// ---------------------------------------------------------------------------
{
	const pipeline = await newPipeline();
	pipeline.scenario.policy = "ask";
	pipeline.scenario.hasUI = true; // the fake UI selects the approving option
	pipeline.scenario.stored = null;

	const reloaded = await pipeline.reload();
	assert.equal(reloaded.calls, 1, "trust must be resolved exactly once per reload");
	assert.equal(pipeline.settings.isProjectTrusted(), true, "an approved decision must be applied to settings");
	assert.deepEqual(
		sorted(reloaded.names),
		["cli.ts", "global.ts", "project.ts"],
		"approved project extensions must reach final resource resolution",
	);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model", "project settings must be assembled after approval");

	const resolves = resolveEvents(pipeline);
	assert.equal(resolves.length, 2, "reload must resolve extensions twice (bootstrap, then final)");
	assert.equal(resolves[0][1], false, "the bootstrap pass must run untrusted");
	assert.equal(resolves[1][1], true, "the final pass must run with the approved decision");
	assert.equal(resolves[1][2], "project-model", "final resolution must observe merged project settings");
}

{
	// Denial travels the same path: nothing project-scoped may be assembled.
	const pipeline = await newPipeline();
	pipeline.scenario.stored = false;
	pipeline.scenario.policy = "always";
	pipeline.scenario.hasUI = false;

	const reloaded = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false, "a stored denial must leave the runtime untrusted");
	assert.deepEqual(sorted(reloaded.names), ["cli.ts", "global.ts"], "denied project resources must not be loaded");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "a denied project must not contribute settings");
	assert.equal(pipeline.settings.getCompactionReserveTokens(), 8192);
	assert.equal(pipeline.settings.getCompactionKeepRecentTokens(), 2000);

	console.log("ok 3 resource assembly: trust decision is applied before final resource selection");
}

// ---------------------------------------------------------------------------
// 4. Extension-supplied decisions cross the same boundary and persist when asked.
// ---------------------------------------------------------------------------
{
	const approved = await newPipeline();
	approved.scenario.policy = "never";
	approved.scenario.extension = { trusted: "yes", remember: true };
	const reloaded = await approved.reload();
	assert.equal(approved.settings.isProjectTrusted(), true, "an extension approval must reach the runtime");
	assert.deepEqual(
		sorted(reloaded.names),
		["cli.ts", "global.ts", "project.ts"],
		"an extension approval must reach final resource resolution",
	);
	assert.equal(approved.consentWrites.length, 1, "a remembered extension decision must be stored");
	assert.deepEqual(approved.consentWrites[0], [workspace, true]);

	const denied = await newPipeline();
	denied.scenario.policy = "always";
	denied.scenario.extension = { trusted: "no", remember: true };
	const deniedReload = await denied.reload();
	assert.equal(denied.settings.isProjectTrusted(), false, "an extension denial must reach the runtime");
	assert.deepEqual(sorted(deniedReload.names), ["cli.ts", "global.ts"], "an extension denial keeps project resources out");
	assert.deepEqual(denied.consentWrites[0], [workspace, false]);

	console.log("ok 4 extension decisions: remembered results persist and govern resource assembly");
}

console.log("regression passed");
