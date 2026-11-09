/**
 * Regression suite for: "Revocation must clear cached resources and settings".
 *
 * Loads the real production modules (project trust resolver, SettingsManager,
 * DefaultResourceLoader, package-manager binding) through the read-only
 * `.prale-eval/subject.mjs` graph helper. Only external IO (settings storage,
 * extension loader, package resolution, UI) is faked, so every assertion below
 * observes behavior across module boundaries, not a single function in isolation.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 *
 * No dependencies, network, real timers or randomness are used. All ordering is
 * driven by awaited promises, and the settings storage is in-memory, so the run
 * creates no files that would need cleanup.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createResourcePipeline } from "./subject.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Copy values out of the vm realm so strict deep comparison is meaningful. */
function normalize(value) {
	return JSON.parse(JSON.stringify(value));
}

/** Basenames of resolved extension paths, sorted so load order is not asserted. */
function basenames(extensions) {
	const names = [];
	for (const extension of extensions) {
		names.push(path.basename(String(extension.path)));
	}
	return names.sort();
}

function reloadedNames(result) {
	const names = [];
	for (const name of result.names) {
		names.push(String(name));
	}
	return names.sort();
}

const GLOBAL_EXTENSIONS = ["global"];
const PROJECT_SETTINGS = { defaultModel: "project-model", extensions: ["project"], compaction: { reserveTokens: 4096 } };
const TRUSTED_EXTENSIONS = ["cli.ts", "global.ts", "project.ts"];
const UNTRUSTED_EXTENSIONS = ["cli.ts", "global.ts"];

/** A headless reload with no stored decision under the ask policy must deny. */
async function headlessAskDeniesWithoutStoredDecision() {
	const pipeline = await createResourcePipeline(workspace);
	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.stored = null;
	pipeline.scenario.override = undefined;
	pipeline.scenario.extension = undefined;

	// Cross-module check: the resource loader asks the real resolver; the missing
	// UI must not be treated as implicit consent.
	const reloaded = await pipeline.reload();
	assert.equal(reloaded.calls, 1, "the loader must ask for a trust decision exactly once");
	assert.equal(pipeline.settings.isProjectTrusted(), false, "headless ask policy must deny project trust");
	assert.deepEqual(reloadedNames(reloaded), UNTRUSTED_EXTENSIONS, "only global and CLI extensions survive a denial");
	assert.deepEqual(normalize(pipeline.settings.getProjectSettings()), {}, "project settings must stay unloaded");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "global settings must still apply");
	assert.deepEqual(normalize(pipeline.settings.getGlobalSettings()).extensions, GLOBAL_EXTENSIONS);
	assert.deepEqual(pipeline.consentWrites, [], "a denial must not write a trust decision");
	assert.equal(pipeline.settings.isProjectTrusted(), false);

	// The same decision seen by the loader is what the loader observed internally:
	// the post-decision resolution ran against an untrusted manager.
	const resolutions = [];
	for (const event of pipeline.events) {
		if (event[0] === "resolve") resolutions.push([event[1], event[2]]);
	}
	assert.deepEqual(
		resolutions.at(-1),
		[false, "global-model"],
		"the resource set must be resolved with untrusted project settings",
	);
}

/** Approving, then revoking trust, must drop project configuration and extensions. */
async function revocationDropsProjectResourcesAndCachedSettings() {
	const pipeline = await createResourcePipeline(workspace);
	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = true;

	const approved = await pipeline.reload();
	assert.equal(approved.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), true, "a stored approval must be honoured");
	assert.deepEqual(reloadedNames(approved), TRUSTED_EXTENSIONS);
	assert.deepEqual(normalize(pipeline.settings.getProjectSettings()), PROJECT_SETTINGS);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");

	// Reloading without a resolver must retain the existing trust state instead of
	// re-running the bootstrap pass or dropping to an untrusted default.
	await pipeline.loader.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, "reload without a resolver must retain trust");
	assert.deepEqual(basenames(pipeline.loader.getExtensions().extensions), TRUSTED_EXTENSIONS);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");

	// Revocation: the stored decision now denies.
	pipeline.scenario.stored = false;
	const revoked = await pipeline.reload();
	assert.equal(revoked.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), false, "the revoked decision must be applied");
	assert.deepEqual(reloadedNames(revoked), UNTRUSTED_EXTENSIONS, "project extensions must leave the resolved set");
	assert.deepEqual(normalize(pipeline.settings.getProjectSettings()), {}, "cached project settings must be discarded");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "global settings must be preserved");
	assert.deepEqual(normalize(pipeline.settings.getGlobalSettings()).extensions, GLOBAL_EXTENSIONS);

	// The bootstrap pass handed to the resolver must already exclude project extensions.
	const preTrustSets = [];
	await pipeline.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			preTrustSets.push(basenames(extensionsResult.extensions));
			return false;
		},
	});
	assert.deepEqual(preTrustSets, [UNTRUSTED_EXTENSIONS], "the trust prompt must see the untrusted bootstrap set");
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(basenames(pipeline.loader.getExtensions().extensions), UNTRUSTED_EXTENSIONS);
}

/** A CLI-level denial must behave like a revoked stored decision. */
async function cliDenialRevokesPreviouslyApprovedResources() {
	const pipeline = await createResourcePipeline(workspace);
	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.stored = true;
	pipeline.scenario.override = true;

	const approved = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(reloadedNames(approved), TRUSTED_EXTENSIONS);

	pipeline.scenario.override = false;
	const denied = await pipeline.reload();
	assert.equal(denied.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), false, "a CLI denial must revoke project trust");
	assert.deepEqual(reloadedNames(denied), UNTRUSTED_EXTENSIONS);
	assert.deepEqual(normalize(pipeline.settings.getProjectSettings()), {});
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
}

/** Revoking trust through the settings API must be effective immediately. */
async function immediateRevocationDiscardsCachedProjectConfiguration() {
	const pipeline = await createResourcePipeline(workspace);
	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = "ask";
	pipeline.scenario.stored = true;
	await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(normalize(pipeline.settings.getProjectSettings()), PROJECT_SETTINGS);

	pipeline.settings.setProjectTrusted(false);
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(
		normalize(pipeline.settings.getProjectSettings()),
		{},
		"revoking trust must immediately clear cached project settings",
	);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "merged settings must fall back to global values");
	assert.equal(pipeline.settings.getCompactionReserveTokens(), 8192, "global compaction settings must be preserved");
	assert.throws(
		() => pipeline.settings.setProjectExtensionPaths(["project-only"]),
		/not trusted/,
		"an untrusted project must not accept project setting writes",
	);

	// The next resolved resource set — resolved without a resolver — must agree.
	await pipeline.loader.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false, "reload without a resolver must retain the revocation");
	assert.deepEqual(basenames(pipeline.loader.getExtensions().extensions), UNTRUSTED_EXTENSIONS);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(normalize(pipeline.settings.getProjectSettings()), {});
}

/** Documented non-ask policies and the interactive prompt must keep working. */
async function explicitPoliciesAndInteractivePromptStillWork() {
	const always = await createResourcePipeline(workspace);
	always.scenario.hasUI = false;
	always.scenario.policy = "always";
	always.scenario.stored = null;
	const alwaysResult = await always.reload();
	assert.equal(always.settings.isProjectTrusted(), true, "the always policy must load protected resources");
	assert.deepEqual(reloadedNames(alwaysResult), TRUSTED_EXTENSIONS);
	assert.deepEqual(normalize(always.settings.getProjectSettings()), PROJECT_SETTINGS);

	const never = await createResourcePipeline(workspace);
	never.scenario.hasUI = false;
	never.scenario.policy = "never";
	never.scenario.stored = null;
	const neverResult = await never.reload();
	assert.equal(never.settings.isProjectTrusted(), false, "the never policy must deny protected resources");
	assert.deepEqual(reloadedNames(neverResult), UNTRUSTED_EXTENSIONS);
	assert.deepEqual(normalize(never.settings.getProjectSettings()), {});

	const interactive = await createResourcePipeline(workspace);
	interactive.scenario.hasUI = true;
	interactive.scenario.policy = "ask";
	interactive.scenario.stored = null;
	const interactiveResult = await interactive.reload();
	assert.equal(interactive.settings.isProjectTrusted(), true, "an interactive approval must be honoured");
	assert.deepEqual(reloadedNames(interactiveResult), TRUSTED_EXTENSIONS);
	assert.deepEqual(interactive.consentWrites, [], "a session-only approval must not persist a decision");
}

await headlessAskDeniesWithoutStoredDecision();
await revocationDropsProjectResourcesAndCachedSettings();
await cliDenialRevokesPreviouslyApprovedResources();
await immediateRevocationDiscardsCachedProjectConfiguration();
await explicitPoliciesAndInteractivePromptStillWork();

console.log("regression: revocation clears cached resources and settings — all assertions passed");
