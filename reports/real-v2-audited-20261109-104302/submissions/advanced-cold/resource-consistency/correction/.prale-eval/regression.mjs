/**
 * Cross-module regression for the project-trust producer/consumer flow.
 *
 * Producers/consumers exercised (all real, no source rewriting):
 *   core/project-trust.ts   decides trust (extension event, saved decision, prompt)
 *   core/settings-manager.ts applies trust to the loaded project settings
 *   core/resource-loader.ts bootstraps untrusted, asks the resolver once, then reloads
 *
 * Only external IO/provider boundaries are faked by the read-only subject helper.
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createResourcePipeline } from "./subject.mjs";

const workspace = process.cwd();
const scratch = path.join(workspace, ".prale-eval", "tmp-fixture");
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
/** Bootstrap may only see user/global + CLI extensions, never the project extension. */
const BOOTSTRAP_EXTENSIONS = ["cli.ts", "global.ts"];
const TRUSTED_EXTENSIONS = ["cli.ts", "global.ts", "project.ts"];

/** Values cross a vm realm boundary; compare structure, not realm-specific prototypes. */
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resolveCalls(pipeline) {
	return pipeline.events
		.filter((event) => event[0] === "resolve")
		.map(([, trusted, model]) => ({ trusted, model }));
}

function extensionLoads(pipeline) {
	return pipeline.events
		.filter((event) => event[0] === "load")
		.map(([, files]) => Array.from(files, (file) => path.basename(file)));
}

/** A resolver input shaped like the real bootstrap result; the extension event is faked. */
const BOOTSTRAP_RESULT = { extensions: [], errors: [], runtime: {} };

async function pipeline() {
	return createResourcePipeline(scratch);
}

async function testUntrustedBootstrapThenApproval() {
	const flow = await pipeline();
	// A saved approval exists, but it must not leak into the untrusted bootstrap pass.
	flow.scenario.stored = true;

	const result = await flow.reload();

	assert.equal(result.calls, 1, "resource-loader must ask the trust resolver exactly once after the untrusted bootstrap");
	assert.deepEqual(plain(result.names), TRUSTED_EXTENSIONS, "approved project extension must be loaded after trust resolves");

	const resolves = resolveCalls(flow);
	assert.equal(resolves.length, 2, "expected one bootstrap resolve and one post-trust resolve");
	assert.deepEqual(resolves[0], { trusted: false, model: "global-model" }, "bootstrap extension scan must run untrusted");
	assert.deepEqual(resolves[1], { trusted: true, model: "project-model" }, "post-trust scan must run trusted");

	const loads = extensionLoads(flow);
	assert.deepEqual(plain(loads[0]), BOOTSTRAP_EXTENSIONS, "bootstrap extension load must exclude project extensions");
	assert.equal(flow.settings.isProjectTrusted(), true, "settings manager must record the trusted decision");
	assert.deepEqual(
		plain(flow.settings.getProjectSettings()),
		PROJECT_SETTINGS,
		"changing trust must actually reload project settings",
	);
	assert.deepEqual(plain(flow.settings.getGlobalSettings()), GLOBAL_SETTINGS, "global settings must stay untouched");
	assert.deepEqual(flow.consentWrites, [], "a stored approval must not be rewritten during reload");
	assert.equal(
		flow.storageData.global,
		JSON.stringify(GLOBAL_SETTINGS),
		"global configuration must not be mutated by a session decision",
	);
}

async function testUntrustedBootstrapThenDenial() {
	const flow = await pipeline();
	// A saved denial keeps the resolver decision at "no" without persisting anything new.
	flow.scenario.stored = false;

	const result = await flow.reload();

	assert.equal(result.calls, 1, "the resolver must run exactly once for a denial too");
	assert.deepEqual(plain(result.names), BOOTSTRAP_EXTENSIONS, "denied project extensions must stay unloaded");
	assert.deepEqual(
		resolveCalls(flow).map((entry) => entry.trusted),
		[false, false],
		"both the bootstrap and the post-denial scan must be untrusted",
	);
	assert.equal(flow.settings.isProjectTrusted(), false, "settings manager must record the denial");
	assert.deepEqual(plain(flow.settings.getProjectSettings()), {}, "denied project settings must stay empty");
	assert.deepEqual(plain(flow.settings.getGlobalSettings()), GLOBAL_SETTINGS, "denial must not drop global settings");
	assert.deepEqual(flow.consentWrites, [], "a saved denial must not be rewritten during reload");
	assert.equal(flow.storageData.global, JSON.stringify(GLOBAL_SETTINGS), "global configuration must stay untouched");
}

async function testSessionOnlyPromptApproval() {
	const flow = await pipeline();
	// No override, no saved decision, interactive UI: the session-only prompt option wins.
	flow.scenario.hasUI = true;
	flow.scenario.policy = "ask";

	const result = await flow.reload();

	assert.equal(result.calls, 1, "the prompt path must also resolve once");
	assert.deepEqual(plain(result.names), TRUSTED_EXTENSIONS, "session-only approval must grant access for this run");
	assert.deepEqual(flow.consentWrites, [], "a session-only approval must not be persisted as consent");
	assert.equal(flow.settings.isProjectTrusted(), true, "session-only approval must still trust for this session");
	assert.equal(
		flow.storageData.global,
		JSON.stringify(GLOBAL_SETTINGS),
		"a session-only decision must not touch global configuration",
	);
}

async function testExtensionDecisionWithoutRemember() {
	const approval = await pipeline();
	approval.scenario.extension = { trusted: "yes" };
	assert.equal(await approval.resolve(BOOTSTRAP_RESULT), true, "extension approval must grant access");
	assert.deepEqual(approval.consentWrites, [], "extension approval without remember must not persist consent");

	const denial = await pipeline();
	denial.scenario.extension = { trusted: "no" };
	assert.equal(await denial.resolve(BOOTSTRAP_RESULT), false, "extension denial must deny access");
	assert.deepEqual(denial.consentWrites, [], "extension denial without remember must not persist a decision");
}

async function testExtensionDecisionWithRememberFalse() {
	const approval = await pipeline();
	approval.scenario.extension = { trusted: "yes", remember: false };
	assert.equal(await approval.resolve(BOOTSTRAP_RESULT), true, "remember=false approval must still grant access");
	assert.deepEqual(approval.consentWrites, [], "remember=false must not persist the extension approval");

	const denial = await pipeline();
	denial.scenario.extension = { trusted: "no", remember: false };
	assert.equal(await denial.resolve(BOOTSTRAP_RESULT), false, "remember=false denial must still deny access");
	assert.deepEqual(denial.consentWrites, [], "remember=false must not persist the extension denial");
}

async function testExtensionDecisionWithExplicitRemember() {
	const approval = await pipeline();
	approval.scenario.extension = { trusted: "yes", remember: true };
	assert.equal(await approval.resolve(BOOTSTRAP_RESULT), true, "remember=true approval must grant access");
	assert.deepEqual(
		plain(approval.consentWrites),
		[[scratch, true]],
		"remember=true must persist the approval for the project path",
	);

	const denial = await pipeline();
	denial.scenario.extension = { trusted: "no", remember: true };
	assert.equal(await denial.resolve(BOOTSTRAP_RESULT), false, "remember=true denial must deny access");
	assert.deepEqual(
		plain(denial.consentWrites),
		[[scratch, false]],
		"remember=true must persist the denial for the project path",
	);
}

async function testExtensionApprovalDrivesLoader() {
	const flow = await pipeline();
	// No override and no saved decision: the extension decides after the untrusted bootstrap.
	flow.scenario.extension = { trusted: "yes" };

	const result = await flow.reload();

	assert.equal(result.calls, 1, "the loader must resolve trust exactly once");
	assert.deepEqual(
		plain(result.names),
		TRUSTED_EXTENSIONS,
		"the resolver must receive the bootstrap extension result so the extension can decide",
	);
	assert.equal(
		flow.events.some((event) => event[0] === "extension-decision"),
		true,
		"the project_trust event must be emitted from the bootstrap extension set",
	);
	assert.equal(flow.settings.isProjectTrusted(), true, "extension approval must trust the project for this session");
	assert.deepEqual(flow.consentWrites, [], "extension approval without remember must not persist consent");
}

// Local test input lives under .prale-eval/ and is always removed again. The
// sandbox project root only needs to link the real packages so the subject helper
// can load the submitted modules; nothing outside the workspace is touched.
function createScratchRoot() {
	fs.rmSync(scratch, { recursive: true, force: true });
	fs.mkdirSync(scratch, { recursive: true });
	fs.symlinkSync(path.join(workspace, "packages"), path.join(scratch, "packages"), "dir");
}
createScratchRoot();
try {
	await testUntrustedBootstrapThenApproval();
	await testUntrustedBootstrapThenDenial();
	await testSessionOnlyPromptApproval();
	await testExtensionDecisionWithoutRemember();
	await testExtensionDecisionWithRememberFalse();
	await testExtensionDecisionWithExplicitRemember();
	await testExtensionApprovalDrivesLoader();
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("ok - project trust bootstrap, reload, and persistence agree across modules");
