#!/usr/bin/env node
/**
 * Cross-module regression for the untrusted-startup boundary.
 *
 * The real project-trust resolver, SettingsManager and DefaultResourceLoader are linked by
 * `.prale-eval/subject.mjs` (only external IO/provider boundaries are faked). Every assertion
 * below observes a boundary between modules:
 *
 *   resource-loader bootstrap -> SettingsManager trust state -> package resolution
 *   resolveProjectTrusted    -> SettingsManager trust state -> trusted reload resources
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createResourcePipeline } from "./subject.mjs";

// Module graph root: the repository that contains packages/**. Also the loader cwd.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, ".prale-eval", "tmp", "regression-work");

const baseName = (file) => path.basename(file);
const evt = (pipeline, kind) => pipeline.events.filter(([name]) => name === kind);
const resolveEvents = (pipeline) => evt(pipeline, "resolve");
const loadEvents = (pipeline) => evt(pipeline, "load");
const sorted = (values) => [...values].sort();
// Values produced inside the vm module graphs have foreign prototypes; compare them structurally.
const plain = (value) => JSON.parse(JSON.stringify(value));

const GLOBAL_SETTINGS = {
	defaultModel: "global-model",
	theme: "global-theme",
	extensions: ["global"],
	compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
};
const PROJECT_SETTINGS = {
	defaultModel: "project-model",
	theme: "project-theme",
	extensions: ["project"],
	compaction: { reserveTokens: 4096 },
};

const UNTRUSTED_COMPACTION = { enabled: true, reserveTokens: 8192, keepRecentTokens: 2000 };
const TRUSTED_COMPACTION = { enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 };

/** In-memory storage whose seed content comes from the on-disk test inputs. */
function makeStorage(globalJson, projectJson) {
	const data = { global: globalJson, project: projectJson };
	return {
		data,
		withLock(scope, fn) {
			const next = fn(data[scope]);
			if (next !== undefined) data[scope] = next;
		},
	};
}

/**
 * Start a fresh untrusted bootstrap on an already-trusted process and inspect the boundary
 * where the loader asks for the trust decision: at that instant the process must still be
 * running on global settings only.
 */
async function startUntrustedBootstrap(pipeline) {
	const snapshot = {};
	const decisionCalls = { count: 0 };
	await pipeline.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			decisionCalls.count += 1;
			snapshot.trusted = pipeline.settings.isProjectTrusted();
			snapshot.defaultModel = pipeline.settings.getDefaultModel();
			snapshot.projectSettings = pipeline.settings.getProjectSettings();
			snapshot.compaction = pipeline.settings.getCompactionSettings();
			snapshot.extensionsAtDecision = extensionsResult.extensions.map((entry) => baseName(entry.path));
			snapshot.loadsAtDecision = loadEvents(pipeline).map(([, files]) => files);
			return pipeline.resolve(extensionsResult);
		},
	});
	return { snapshot, decisionCalls };
}

async function testBootstrapReadsOnlyGlobalConfiguration() {
	const pipeline = await createResourcePipeline(root);
	// No stored decision, no UI and default policy "ask": the decision is "untrusted".
	pipeline.scenario.hasUI = false;
	const { snapshot, decisionCalls } = await startUntrustedBootstrap(pipeline);

	assert.equal(decisionCalls.count, 1, "the trust boundary must be consulted exactly once");

	// The consumer of the bootstrap extension set must not observe project configuration.
	assert.equal(snapshot.trusted, false, "bootstrap must run with the project untrusted");
	assert.equal(snapshot.defaultModel, "global-model", "bootstrap must read only global settings");
	assert.deepEqual(plain(snapshot.projectSettings), {}, "bootstrap must not expose project settings");
	assert.deepEqual(
		plain(snapshot.compaction),
		UNTRUSTED_COMPACTION,
		"bootstrap must keep global nested settings and ignore project overrides",
	);

	// The trust resolver receives a global/CLI-only extension set - never project resources.
	assert.deepEqual(
		sorted(snapshot.extensionsAtDecision),
		["cli.ts", "global.ts"],
		"the trust decision must be made over global and CLI resources only",
	);
	assert.ok(
		!snapshot.extensionsAtDecision.includes("project.ts"),
		"project extensions must not be loaded before consent",
	);
	for (const files of snapshot.loadsAtDecision) {
		assert.ok(!files.includes("project.ts"), `project extension loaded before consent: ${files.join(",")}`);
	}

	// Every resolution performed during bootstrap is global-only.
	const bootstrapResolves = resolveEvents(pipeline).slice(0, 1);
	assert.equal(bootstrapResolves.length, 1, "bootstrap must resolve extensions once");
	assert.deepEqual(bootstrapResolves[0], ["resolve", false, "global-model"]);

	// The final (still untrusted) reload keeps global and CLI resources and rejects project ones.
	const resolves = resolveEvents(pipeline);
	assert.equal(resolves.length, 2, "bootstrap plus final reload must resolve extensions");
	assert.deepEqual(resolves[1], ["resolve", false, "global-model"]);
	const finalNames = sorted(pipeline.loader.getExtensions().extensions.map((entry) => baseName(entry.path)));
	assert.deepEqual(finalNames, ["cli.ts", "global.ts"], "untrusted project resources must stay unloaded");
	assert.deepEqual(pipeline.consentWrites, [], "a non-interactive process must not record consent");
}

async function testExplicitFalseOverrideWinsWithoutConsultingExtensions() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.override = false;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.stored = true; // a stored "trusted" decision must not beat the override
	pipeline.scenario.extension = { trusted: "yes", remember: false }; // nor may an extension grant trust
	const reloaded = await pipeline.reload();

	assert.equal(reloaded.calls, 1, "the trust resolver must be consulted exactly once");
	assert.equal(pipeline.settings.isProjectTrusted(), false, "an explicit false override must win");
	assert.equal(
		pipeline.events.some(([kind]) => kind === "extension-decision"),
		false,
		"an explicit override must not consult the project_trust extension hook",
	);
	assert.deepEqual(pipeline.consentWrites, [], "an explicit override must never prompt or record consent");
	assert.deepEqual(sorted(reloaded.names), ["cli.ts", "global.ts"], "explicitly untrusted project stays unloaded");

	// Direct resolver contract on the same real module.
	const before = pipeline.events.length;
	assert.equal(await pipeline.resolve({ extensions: [], errors: [], runtime: {} }), false);
	assert.equal(pipeline.events.length, before, "resolving with an override must not emit extension events");
	pipeline.scenario.override = true;
	assert.equal(await pipeline.resolve({ extensions: [], errors: [], runtime: {} }), true);
	assert.equal(pipeline.events.length, before, "resolving with an override must not emit extension events");
}

async function testTrustedReloadAdmitsProjectResourcesWithNestedInheritance() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.stored = true; // remembered consent
	pipeline.scenario.hasUI = false;
	const reloaded = await pipeline.reload();

	// Bootstrap still happens on global settings only ...
	const loads = loadEvents(pipeline);
	assert.ok(loads.length >= 2, "bootstrap and final passes must each load extensions");
	assert.deepEqual(sorted(loads[0][1]), ["cli.ts", "global.ts"], "bootstrap must not load project extensions");
	assert.deepEqual(
		resolveEvents(pipeline)[0],
		["resolve", false, "global-model"],
		"bootstrap resolution must stay global-only even when trust is already remembered",
	);

	// ... and the trusted reload afterwards admits project resources.
	assert.equal(reloaded.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(
		sorted(reloaded.names),
		["cli.ts", "global.ts", "project.ts"],
		"the trusted reload must admit project resources while preserving global and CLI ones",
	);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(
		plain(pipeline.settings.getCompactionSettings()),
		TRUSTED_COMPACTION,
		"project overrides must win while global nested values are inherited",
	);
}

async function testDefaultNeverPolicyAndSettingsTrustBoundary() {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.policy = "never";
	pipeline.scenario.hasUI = true;
	const reloaded = await pipeline.reload();
	assert.equal(reloaded.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), false, "policy 'never' must not trust the project");
	assert.deepEqual(sorted(reloaded.names), ["cli.ts", "global.ts"], "policy 'never' must keep project resources out");

	// SettingsManager is the producer consumed by both the loader and the resolver.
	const { SettingsManager } = await pipeline.graph.module("settings");
	const globalJson = fs.readFileSync(path.join(workDir, "global-settings.json"), "utf-8");
	const projectJson = fs.readFileSync(path.join(workDir, "project-settings.json"), "utf-8");

	const untrusted = SettingsManager.fromStorage(makeStorage(globalJson, projectJson), { projectTrusted: false });
	assert.equal(untrusted.isProjectTrusted(), false);
	assert.deepEqual(plain(untrusted.getProjectSettings()), {}, "untrusted managers must not expose project settings");
	assert.equal(untrusted.getDefaultModel(), "global-model");
	assert.equal(untrusted.getTheme(), "global-theme");
	assert.deepEqual(plain(untrusted.getCompactionSettings()), UNTRUSTED_COMPACTION);
	await untrusted.reload();
	assert.deepEqual(plain(untrusted.getProjectSettings()), {}, "an untrusted reload must not read project settings");
	assert.equal(untrusted.getDefaultModel(), "global-model");
	assert.deepEqual(plain(untrusted.getCompactionSettings()), UNTRUSTED_COMPACTION);

	// The explicit transition performed by a trusted reload admits project settings afterwards.
	untrusted.setProjectTrusted(true);
	assert.equal(untrusted.getDefaultModel(), "project-model");
	assert.equal(untrusted.getTheme(), "project-theme");
	assert.deepEqual(plain(untrusted.getCompactionSettings()), TRUSTED_COMPACTION);

	// Dropping trust again hides project settings without touching global ones.
	untrusted.setProjectTrusted(false);
	assert.deepEqual(plain(untrusted.getProjectSettings()), {});
	assert.equal(untrusted.getDefaultModel(), "global-model");
	assert.equal(untrusted.getTheme(), "global-theme");
	assert.deepEqual(plain(untrusted.getCompactionSettings()), UNTRUSTED_COMPACTION);
	assert.deepEqual(plain(untrusted.getGlobalSettings()), JSON.parse(globalJson));
}

function createTestInputs() {
	fs.mkdirSync(workDir, { recursive: true });
	fs.writeFileSync(path.join(workDir, "global-settings.json"), JSON.stringify(GLOBAL_SETTINGS, null, 2));
	fs.writeFileSync(path.join(workDir, "project-settings.json"), JSON.stringify(PROJECT_SETTINGS, null, 2));
}

function removeTestInputs() {
	fs.rmSync(path.join(root, ".prale-eval", "tmp"), { recursive: true, force: true });
}

try {
	createTestInputs();
	await testBootstrapReadsOnlyGlobalConfiguration();
	await testExplicitFalseOverrideWinsWithoutConsultingExtensions();
	await testTrustedReloadAdmitsProjectResourcesWithNestedInheritance();
	await testDefaultNeverPolicyAndSettingsTrustBoundary();
	console.log("regression: untrusted startup boundary verified");
} finally {
	removeTestInputs();
}
