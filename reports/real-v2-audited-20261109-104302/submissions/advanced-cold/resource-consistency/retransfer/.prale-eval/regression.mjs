#!/usr/bin/env node
/**
 * Cross-module regression suite for project-trust revocation.
 *
 * Exercises the real submitted modules:
 *   packages/coding-agent/src/core/project-trust.ts
 *   packages/coding-agent/src/core/settings-manager.ts
 *   packages/coding-agent/src/core/resource-loader.ts
 *
 * The read-only `.prale-eval/subject.mjs` helper links those real modules together and
 * only fakes external IO/provider boundaries (settings storage, package manager,
 * extension loader, trust store and UI prompts). No production source is rewritten.
 *
 * Every check is an uncaught `node:assert/strict` assertion: the process exits non-zero
 * as soon as observable behaviour deviates. Async ordering is driven by awaited promises
 * only (no timers, randomness or external services).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createResourcePipeline } from "./subject.mjs";

const workspace = process.cwd();
// Scratch space for local inputs; the pipeline itself only needs in-memory boundaries.
const scratch = path.join(import.meta.dirname, ".tmp-regression");

const PROJECT_EXTENSION = "project.ts";
const GLOBAL_EXTENSION = "global.ts";
const CLI_EXTENSION = "cli.ts";

const extensionNames = (result) => result.extensions.map((extension) => path.basename(extension.path));
const sortedNames = (names) => [...names].sort();
/** Copy values produced inside the VM realm into this realm so deep equality is realm agnostic. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Reload through the real resource loader while observing the extension set that the
 * loader hands to the trust resolver (the pre-trust / bootstrap pass).
 */
async function reloadObservingPreTrust(pipeline) {
	const observed = [];
	await pipeline.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			observed.push(extensionNames(extensionsResult));
			return pipeline.resolve(extensionsResult);
		},
	});
	assert.strictEqual(observed.length, 1, "a reload with a resolver must consult it exactly once");
	return {
		preTrustNames: observed[0],
		names: extensionNames(pipeline.loader.getExtensions()),
	};
}

/** Assert the resource set is global + CLI only (project resources revoked). */
function assertNoProjectResources(names, label) {
	assert.ok(!names.includes(PROJECT_EXTENSION), `${label}: project extension must be absent, got ${names}`);
	assert.ok(names.includes(GLOBAL_EXTENSION), `${label}: global extension must be preserved, got ${names}`);
	assert.ok(names.includes(CLI_EXTENSION), `${label}: CLI extension must be preserved, got ${names}`);
}

async function main() {
	fs.mkdirSync(scratch, { recursive: true });

	const pipeline = await createResourcePipeline(workspace);
	const { settings, scenario, loader, events, consentWrites, storageData } = pipeline;

	// The project settings file keeps its content throughout: revocation must discard the
	// cached in-memory configuration, never mutate stored user data.
	const storedProject = JSON.parse(storageData.project);
	assert.deepEqual(storedProject.extensions, ["project"]);

	// ---------------------------------------------------------------------
	// 1. Headless reload, no stored decision, "ask" policy => deny access.
	//    Missing UI must not become implicit consent.
	// ---------------------------------------------------------------------
	scenario.override = undefined;
	scenario.stored = null;
	scenario.policy = "ask";
	scenario.hasUI = false;

	assert.strictEqual(
		await pipeline.resolve(undefined),
		false,
		"headless ask-policy resolution without a stored decision must deny",
	);

	const headless = await reloadObservingPreTrust(pipeline);
	assert.strictEqual(settings.isProjectTrusted(), false, "headless denial must leave the project untrusted");
	assert.deepEqual(plain(settings.getProjectSettings()), {}, "denied trust must not expose project configuration");
	assert.strictEqual(settings.getDefaultModel(), "global-model", "denied trust must fall back to global settings");
	assert.strictEqual(settings.getCompactionReserveTokens(), 8192, "global compaction settings must survive denial");
	assert.deepEqual(
		sortedNames(headless.names),
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"denied trust must resolve only global and CLI extensions",
	);
	assert.deepEqual(
		sortedNames(headless.preTrustNames),
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"the pre-trust pass must not load project extensions",
	);
	assert.deepEqual(consentWrites, [], "a headless denial must never persist a trust decision");

	// ---------------------------------------------------------------------
	// 2. Stored decisions still win over the policy, and a prompt result is
	//    still honoured when a UI is available.
	// ---------------------------------------------------------------------
	scenario.stored = false;
	assert.strictEqual(await pipeline.resolve(undefined), false, "a stored denial must be honoured");
	scenario.stored = true;
	assert.strictEqual(await pipeline.resolve(undefined), true, "a stored approval must be honoured");
	scenario.stored = null;
	scenario.hasUI = true;
	assert.strictEqual(await pipeline.resolve(undefined), true, "a UI approval must still grant trust");
	scenario.override = undefined;
	scenario.hasUI = false;

	// ---------------------------------------------------------------------
	// 3. Previous approval: project settings and project extensions are live.
	// ---------------------------------------------------------------------
	scenario.override = true;
	const approved = await reloadObservingPreTrust(pipeline);
	assert.strictEqual(settings.isProjectTrusted(), true, "an approval must trust the project");
	assert.deepEqual(
		plain(settings.getProjectSettings()),
		{ defaultModel: "project-model", extensions: ["project"], compaction: { reserveTokens: 4096 } },
		"an approval must load project configuration",
	);
	assert.strictEqual(settings.getDefaultModel(), "project-model", "project configuration must override globals");
	assert.strictEqual(settings.getCompactionReserveTokens(), 4096, "project compaction settings must apply");
	assert.deepEqual(
		sortedNames(approved.names),
		[CLI_EXTENSION, GLOBAL_EXTENSION, PROJECT_EXTENSION],
		"an approval must resolve project extensions",
	);
	assert.deepEqual(
		sortedNames(approved.preTrustNames),
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"the pre-trust pass must stay project-free even when the project is approved",
	);

	// A reload without a resolver must retain the existing trust state instead of
	// running the bootstrap pass again.
	const retainedEvents = events.length;
	await loader.reload();
	assert.strictEqual(settings.isProjectTrusted(), true, "reload without a resolver must retain trust");
	assert.strictEqual(settings.getDefaultModel(), "project-model", "reload without a resolver must retain settings");
	assert.deepEqual(
		sortedNames(extensionNames(loader.getExtensions())),
		[CLI_EXTENSION, GLOBAL_EXTENSION, PROJECT_EXTENSION],
		"reload without a resolver must retain project extensions",
	);
	assert.ok(
		!events.slice(retainedEvents).some((event) => event[0] === "extension-decision"),
		"reload without a resolver must not re-decide trust",
	);

	// ---------------------------------------------------------------------
	// 4. Revocation: the cached project configuration is discarded and project
	//    extensions disappear from the next resolved resource set.
	// ---------------------------------------------------------------------
	scenario.override = false;
	const revokeStart = events.length;
	const revoked = await reloadObservingPreTrust(pipeline);
	assert.strictEqual(settings.isProjectTrusted(), false, "revocation must leave the project untrusted");
	assert.deepEqual(plain(settings.getProjectSettings()), {}, "revocation must discard cached project configuration");
	assert.strictEqual(settings.getDefaultModel(), "global-model", "revocation must restore the global model");
	assert.strictEqual(settings.getCompactionReserveTokens(), 8192, "revocation must restore global compaction settings");
	assert.deepEqual(
		plain(settings.getGlobalSettings().extensions),
		["global"],
		"revocation must leave global extension configuration intact",
	);
	assertNoProjectResources(revoked.names, "revocation");
	assert.deepEqual(
		sortedNames(revoked.preTrustNames),
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"the pre-trust pass after revocation must not load project extensions",
	);

	// The settings manager must observe the revoked trust state before the resource set
	// is resolved, and the resolved set must be derived from global-only settings.
	const revokeEvents = events.slice(revokeStart);
	const resolves = revokeEvents.filter((event) => event[0] === "resolve");
	assert.ok(resolves.length >= 2, "a revoking reload must resolve resources before and after the decision");
	assert.deepEqual(
		resolves.at(-1),
		["resolve", false, "global-model"],
		"the final resolve must observe the revoked trust state and global-only settings",
	);
	assert.deepEqual(
		JSON.parse(storageData.project),
		storedProject,
		"revocation must not rewrite the stored project settings file",
	);

	// ---------------------------------------------------------------------
	// 5. SettingsManager revocation is immediate for every consumer, even
	//    before the next reload: cached project settings vanish at once.
	// ---------------------------------------------------------------------
	settings.setProjectTrusted(true);
	assert.strictEqual(settings.isProjectTrusted(), true, "re-trusting must load project configuration again");
	assert.strictEqual(settings.getDefaultModel(), "project-model", "re-trusting must restore the project model");
	assert.strictEqual(settings.getCompactionReserveTokens(), 4096, "re-trusting must restore project compaction");

	settings.setProjectTrusted(false);
	assert.strictEqual(settings.isProjectTrusted(), false, "setProjectTrusted(false) must revoke trust");
	assert.deepEqual(plain(settings.getProjectSettings()), {}, "setProjectTrusted(false) must clear cached project settings");
	assert.strictEqual(settings.getDefaultModel(), "global-model", "revoked settings must resolve to globals");
	assert.strictEqual(settings.getCompactionReserveTokens(), 8192, "revoked compaction must resolve to globals");
	assert.deepEqual(plain(settings.getGlobalSettings().extensions), ["global"], "global settings must be preserved");

	// Reloading while untrusted must not resurrect the project configuration.
	await loader.reload();
	assert.strictEqual(settings.isProjectTrusted(), false, "reload without a resolver must retain revocation");
	assert.deepEqual(plain(settings.getProjectSettings()), {}, "reload while untrusted must not reload project settings");
	assertNoProjectResources(extensionNames(loader.getExtensions()), "reload after revocation");

	console.log("regression: project trust revocation clears settings and project resources (all assertions passed)");
}

try {
	await main();
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
