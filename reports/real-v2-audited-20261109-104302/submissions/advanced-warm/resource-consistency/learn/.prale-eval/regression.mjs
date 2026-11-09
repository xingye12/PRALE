#!/usr/bin/env node
/**
 * End-to-end regression for the untrusted startup / project trust boundary.
 *
 * The real `resource-loader`, `settings-manager` and `project-trust` modules are
 * executed together through `.prale-eval/subject.mjs`; only storage, package
 * resolution, the extension loader and the UI are faked. Every assertion below
 * fails if any one of the three production modules regresses on its own:
 *
 *  - resource-loader: the pre-consent bootstrap must force untrusted settings,
 *  - settings-manager: project settings must not be parsed while untrusted,
 *  - project-trust: an explicit override (including `false`) must win silently.
 */
import assert from "node:assert/strict";
import { createResourcePipeline } from "./subject.mjs";

const root = process.cwd();

/** Plain host-realm copy of a value produced inside the VM context. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const resolveCalls = (pipeline) =>
	pipeline.events.filter((event) => event[0] === "resolve").map((event) => plain(event));

const loadCalls = (pipeline) => pipeline.events.filter((event) => event[0] === "load").map((event) => plain(event));

const hasEvent = (pipeline, name) => pipeline.events.some((event) => event[0] === name);

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

function makeStorage(entries) {
	const data = {
		global: JSON.stringify(entries.global),
		project: JSON.stringify(entries.project),
	};
	return {
		data,
		withLock(scope, fn) {
			const next = fn(data[scope]);
			if (next !== undefined) {
				data[scope] = next;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Fresh bootstrap: global + CLI resources only, project configuration invisible.
//    (resource-loader forces untrusted settings; settings-manager must honor it.)
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = false;
	pipeline.scenario.stored = null;
	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = "ask";

	const result = await pipeline.reload();
	const calls = resolveCalls(pipeline);

	assert.equal(calls.length, 2, "reload resolves packages once for the bootstrap pass and once for the final pass");
	assert.deepEqual(
		calls[0],
		["resolve", false, "global-model"],
		"the pre-consent bootstrap pass must read global configuration only",
	);

	const loads = loadCalls(pipeline);
	assert.equal(loads.length >= 1, true, "the bootstrap pass must load an extension set");
	assert.deepEqual(
		loads[0],
		["load", ["cli.ts", "global.ts"]],
		"the bootstrap pass keeps global and CLI extensions but never project extensions",
	);

	assert.equal(pipeline.settings.isProjectTrusted(), false, "an explicit false override leaves the project untrusted");
	assert.deepEqual(
		plain(pipeline.settings.getProjectSettings()),
		{},
		"no project settings are visible before consent",
	);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(
		plain(pipeline.settings.getGlobalSettings()),
		GLOBAL_SETTINGS,
		"global settings stay intact during the untrusted bootstrap",
	);
	assert.deepEqual(
		plain(result.names),
		["cli.ts", "global.ts"],
		"the final extension set holds global and CLI resources only",
	);
	assert.deepEqual(plain(pipeline.consentWrites), [], "an explicit false override never asks for consent");
}

// ---------------------------------------------------------------------------
// 2. Trusted reload admits project resources and keeps nested inheritance.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = true;
	pipeline.scenario.stored = null;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = "ask";

	const result = await pipeline.reload();
	const calls = resolveCalls(pipeline);

	assert.equal(calls.length, 2, "a trusted reload still bootstraps untrusted and then re-resolves");
	assert.deepEqual(
		calls[0],
		["resolve", false, "global-model"],
		"the trusted path also bootstraps from global configuration only",
	);
	assert.deepEqual(
		calls[1],
		["resolve", true, "project-model"],
		"after consent the project configuration becomes visible",
	);
	assert.deepEqual(
		plain(result.names),
		["cli.ts", "global.ts", "project.ts"],
		"trusted reload admits project extensions next to global and CLI ones",
	);
	assert.deepEqual(
		plain(pipeline.consentWrites),
		[],
		"an explicit true override decides without prompting or persisting consent",
	);

	assert.deepEqual(plain(pipeline.settings.getProjectSettings()), PROJECT_SETTINGS);
	assert.deepEqual(
		plain(pipeline.settings.getGlobalSettings()),
		GLOBAL_SETTINGS,
		"admitting project settings never rewrites the global scope",
	);
	assert.equal(pipeline.settings.getCompactionReserveTokens(), 4096, "project nested value wins");
	assert.equal(
		pipeline.settings.getCompactionKeepRecentTokens(),
		2000,
		"nested settings inheritance keeps the global sibling value",
	);
}

// ---------------------------------------------------------------------------
// 3. Explicit false override beats a remembered trust decision, silently.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = false;
	pipeline.scenario.stored = true;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = "always";

	const result = await pipeline.reload();

	assert.equal(
		hasEvent(pipeline, "extension-decision"),
		false,
		"an explicit false override short-circuits the extension trust decision",
	);
	assert.deepEqual(plain(pipeline.consentWrites), [], "an explicit false override never persists consent");
	assert.equal(
		pipeline.settings.isProjectTrusted(),
		false,
		"a remembered trust decision (and an 'always' policy) loses against the explicit false override",
	);
	assert.deepEqual(
		plain(result.names),
		["cli.ts", "global.ts"],
		"the explicit false override keeps project resources out of the final set",
	);
}

// ---------------------------------------------------------------------------
// 4. Remembered decisions and prompting are untouched when no override is given.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = false;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = "ask";

	const result = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(plain(pipeline.consentWrites), [], "a stored decision is honored without prompting");
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"]);
}

// ---------------------------------------------------------------------------
// 5. SettingsManager trust gate and nested inheritance across reloads.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	const { SettingsManager } = await pipeline.graph.module("settings");
	const storage = makeStorage({ global: GLOBAL_SETTINGS, project: PROJECT_SETTINGS });

	const untrusted = SettingsManager.fromStorage(storage, { projectTrusted: false });
	assert.equal(untrusted.isProjectTrusted(), false);
	assert.deepEqual(plain(untrusted.getProjectSettings()), {}, "untrusted load must skip project settings");
	assert.equal(untrusted.getDefaultModel(), "global-model");
	assert.deepEqual(plain(untrusted.getGlobalSettings()), GLOBAL_SETTINGS);

	await untrusted.reload();
	assert.deepEqual(
		plain(untrusted.getProjectSettings()),
		{},
		"an untrusted reload must not parse project settings",
	);
	assert.equal(untrusted.getDefaultModel(), "global-model");

	assert.throws(
		() => untrusted.setProjectExtensionPaths(["npm:held"]),
		/refusing to write project settings/,
		"untrusted project writes are still refused",
	);

	untrusted.setProjectTrusted(true);
	assert.equal(untrusted.isProjectTrusted(), true);
	assert.equal(untrusted.getDefaultModel(), "project-model", "trust change admits project settings");
	assert.deepEqual(plain(untrusted.getProjectSettings()), PROJECT_SETTINGS);
	assert.deepEqual(
		plain(untrusted.getGlobalSettings()),
		GLOBAL_SETTINGS,
		"global settings remain untouched after the trust change",
	);
	assert.deepEqual(
		plain(untrusted.getCompactionSettings()),
		{ enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 },
		"nested compaction settings inherit the global keepRecentTokens value",
	);

	untrusted.setProjectTrusted(false);
	await untrusted.reload();
	assert.deepEqual(
		plain(untrusted.getProjectSettings()),
		{},
		"dropping trust hides project settings again on the next reload",
	);
	assert.equal(untrusted.getDefaultModel(), "global-model");
}
