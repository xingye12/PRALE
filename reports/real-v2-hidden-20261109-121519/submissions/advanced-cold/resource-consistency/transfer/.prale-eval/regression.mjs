/**
 * Cross-module regression for stored-denial authority, trusted settings
 * precedence and approved-decision propagation into resource resolution.
 *
 * The real project-trust resolver, SettingsManager (parsing/merge/trust) and
 * DefaultResourceLoader are linked from the submitted production sources by
 * ./subject.mjs. Only storage, extension loading and UI/provider boundaries
 * are faked, and every faked boundary is deterministic.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createResourcePipeline } from "./subject.mjs";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
// Harness reads the production modules relative to this root; no files are written.
const root = path.resolve(evalDir, "..");

// Values produced inside the vm context carry that realm's prototypes; clone
// them into this realm before strict deep comparison.
const host = (value) => structuredClone(value);

function resolveEvents(pipeline) {
	return pipeline.events.filter((event) => event[0] === "resolve");
}

async function main() {
	// 1. A stored denial is authoritative even when the fallback policy allows.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.stored = false;
		pipeline.scenario.policy = "always";
		assert.equal(
			await pipeline.resolve(undefined),
			false,
			"a stored denial must override an allow-by-default policy",
		);
	}

	// 2. A stored allow is authoritative even when the fallback policy denies.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.stored = true;
		pipeline.scenario.policy = "never";
		assert.equal(
			await pipeline.resolve(undefined),
			true,
			"a stored allow must override a deny-by-default policy",
		);
	}

	// 3. A truly absent decision still falls through to the default policy.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.stored = null;
		pipeline.scenario.policy = "always";
		assert.equal(await pipeline.resolve(undefined), true, "an absent decision must use the default policy");
		pipeline.scenario.policy = "never";
		assert.equal(await pipeline.resolve(undefined), false, "an absent decision must use the default policy");
	}

	// 4. Project values override global values and nested global defaults survive.
	{
		const pipeline = await createResourcePipeline(root);
		assert.equal(pipeline.settings.getDefaultModel(), "project-model", "project values must win while trusted");
		assert.deepEqual(
			host(pipeline.settings.getCompactionSettings()),
			{ enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 },
			"project nested override must win while the untouched global nested default survives",
		);
		assert.deepEqual(host(pipeline.settings.getGlobalSettings().extensions), ["global"]);
		assert.deepEqual(host(pipeline.settings.getProjectSettings().extensions), ["project"]);

		// 5. The same project values disappear only when trust is withdrawn.
		pipeline.settings.setProjectTrusted(false);
		assert.equal(pipeline.settings.isProjectTrusted(), false);
		assert.equal(pipeline.settings.getDefaultModel(), "global-model", "untrusted project values must not override global");
		assert.deepEqual(Object.keys(pipeline.settings.getProjectSettings()), [], "untrusted project settings must not be loaded");
		assert.equal(pipeline.settings.getCompactionReserveTokens(), 8192);
		assert.equal(pipeline.settings.getCompactionKeepRecentTokens(), 2000, "nested global defaults survive without trust");

		pipeline.settings.setProjectTrusted(true);
		assert.equal(pipeline.settings.getDefaultModel(), "project-model", "re-trusted project values must return");
		assert.equal(pipeline.settings.getCompactionReserveTokens(), 4096);
	}

	// 6. An extension-approved decision reaches final resource resolution.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.extension = { trusted: "yes" };
		pipeline.scenario.stored = false;
		pipeline.scenario.policy = "never";

		const reload = await pipeline.reload();
		assert.equal(reload.calls, 1, "reload must resolve project trust exactly once");
		assert.deepEqual(
			host(reload.names),
			["cli.ts", "global.ts", "project.ts"],
			"an approved decision must make project extensions reach final resource resolution",
		);
		assert.equal(pipeline.settings.isProjectTrusted(), true, "the approved decision must update settings trust");
		assert.equal(pipeline.settings.getDefaultModel(), "project-model");
		assert.deepEqual(host(pipeline.settings.getProjectSettings().extensions), ["project"]);

		const resolutions = resolveEvents(pipeline);
		assert.equal(resolutions.length, 2, "resource resolution runs for the bootstrap pass and the final pass");
		assert.deepEqual(
			resolutions[0],
			["resolve", false, "global-model"],
			"the bootstrap pass must resolve only global configuration",
		);
		assert.deepEqual(
			resolutions[resolutions.length - 1],
			["resolve", true, "project-model"],
			"the approved decision must reach final resource resolution",
		);
	}

	// 7. A stored denial reaches final resource resolution and keeps project config out.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.stored = false;
		pipeline.scenario.policy = "always";

		const reload = await pipeline.reload();
		assert.deepEqual(
			host(reload.names),
			["cli.ts", "global.ts"],
			"a stored denial must keep project extensions out of final resolution",
		);
		assert.equal(pipeline.settings.isProjectTrusted(), false);
		assert.equal(pipeline.settings.getDefaultModel(), "global-model");
		assert.deepEqual(pipeline.settings.getProjectSettings(), {});

		const resolutions = resolveEvents(pipeline);
		assert.deepEqual(
			resolutions[resolutions.length - 1],
			["resolve", false, "global-model"],
			"the stored denial must survive the final resource resolution pass",
		);
	}

	// 8. A stored allow also survives an accepted reload.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.stored = true;
		pipeline.scenario.policy = "ask";

		const reload = await pipeline.reload();
		assert.deepEqual(host(reload.names), ["cli.ts", "global.ts", "project.ts"]);
		assert.equal(pipeline.settings.isProjectTrusted(), true);
		assert.equal(pipeline.settings.getDefaultModel(), "project-model");

		const resolutions = resolveEvents(pipeline);
		assert.deepEqual(resolutions[resolutions.length - 1], ["resolve", true, "project-model"]);
	}

	// 9. An interactive approval is also honoured by final resolution.
	{
		const pipeline = await createResourcePipeline(root);
		pipeline.scenario.stored = null;
		pipeline.scenario.policy = "ask";
		pipeline.scenario.hasUI = true;

		const reload = await pipeline.reload();
		assert.deepEqual(host(reload.names), ["cli.ts", "global.ts", "project.ts"]);
		assert.equal(pipeline.settings.isProjectTrusted(), true);
		assert.equal(pipeline.settings.getDefaultModel(), "project-model");
		assert.deepEqual(
			pipeline.consentWrites,
			[],
			"a session-only approval must not persist a trust decision",
		);
	}

	console.log("resource consistency regression: 9 scenarios passed");
}

await main();
