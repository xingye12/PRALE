/**
 * Cross-module regression for advanced/resource-consistency/retransfer.
 *
 * Loads the real project-trust -> resource-loader -> settings-manager modules through
 * the read-only subject helper and asserts observable behavior:
 *   - a headless reload with no stored decision and "ask" policy must deny access;
 *   - revoking a previous approval must discard project configuration immediately and
 *     remove project extensions from the next resolved resource set;
 *   - global and CLI resources survive revocation;
 *   - reload without a resolver must retain the existing trust state.
 *
 * Only in-memory storage, extension loading and package resolution boundaries are faked;
 * trust resolution, settings merging and resource selection are the submitted code.
 */
import assert from "node:assert/strict";
import { basename } from "node:path";
import { createResourcePipeline } from "./subject.mjs";

const cwd = process.cwd();
const newPipeline = () => createResourcePipeline(cwd);
// Extension arrays live in the graph's VM realm; copy them into host arrays so that
// strict deep comparisons are about values rather than realm-specific prototypes.
const loadedNames = (loader) =>
	Array.from(loader.getExtensions().extensions, (extension) => basename(extension.path));
const namesOf = (outcome) => Array.from(outcome.names);
const resolveEvents = (events) => events.filter(([kind]) => kind === "resolve");
const loadEvents = (events) => events.filter(([kind]) => kind === "load");
const sawTrustPrompt = (events) => events.some(([kind]) => kind === "extension-decision");

function assertDeniedResolveEvents(events) {
	for (const [, trusted] of resolveEvents(events)) {
		assert.equal(trusted, false, "untrusted resolution must never expose project resources");
	}
}

function assertNoProjectExtensionLoads(events) {
	for (const [, names] of loadEvents(events)) {
		assert.ok(
			!names.some((name) => name.startsWith("project")),
			`project extensions must not be loaded while untrusted, saw: ${names.join(",")}`,
		);
	}
}

const results = [];
async function scenario(name, run) {
	await run();
	results.push(name);
	console.log(`ok - ${name}`);
}

// 1. Trust resolution semantics without a UI.
await scenario("headless ask without a stored decision denies access", async () => {
	const pipeline = await newPipeline();
	assert.equal(pipeline.scenario.hasUI, false, "precondition: headless context");
	assert.equal(pipeline.scenario.policy, "ask", "precondition: ask policy");
	assert.equal(pipeline.scenario.stored, null, "precondition: no stored decision");
	assert.equal(await pipeline.resolve(undefined), false, "missing UI must fail closed, not imply consent");
});

await scenario("stored decisions, overrides and policies are honored", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.stored = false;
	assert.equal(await pipeline.resolve(undefined), false, "stored denial is respected");
	pipeline.scenario.stored = true;
	assert.equal(await pipeline.resolve(undefined), true, "stored approval is respected without a UI");
	pipeline.scenario.override = false;
	assert.equal(await pipeline.resolve(undefined), false, "explicit revocation wins over a stored approval");
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = null;
	pipeline.scenario.policy = "never";
	assert.equal(await pipeline.resolve(undefined), false, "never policy denies");
	pipeline.scenario.policy = "always";
	assert.equal(await pipeline.resolve(undefined), true, "always policy trusts");
	pipeline.scenario.policy = "ask";
});

await scenario("interactive approval is accepted but not persisted", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.hasUI = true;
	assert.equal(await pipeline.resolve(undefined), true, "interactive selection approves trust");
	assert.deepEqual(pipeline.consentWrites, [], "an approve-once selection must not store a decision");
});

await scenario("extension-provided trust decision is propagated and remembered", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.extension = { trusted: "yes", remember: true };
	const extensionsResult = { extensions: [], errors: [], runtime: {} };
	assert.equal(await pipeline.resolve(extensionsResult), true);
	assert.deepEqual(pipeline.consentWrites, [[cwd, true]], "remembered extension decision is written to the trust store");
});

// 2. Revocation must discard loaded project configuration immediately.
await scenario("setProjectTrusted(false) discards project settings at once", async () => {
	const pipeline = await newPipeline();
	assert.equal(pipeline.settings.isProjectTrusted(), true, "precondition: project starts trusted");
	assert.deepEqual(pipeline.settings.getProjectSettings(), {
		defaultModel: "project-model",
		extensions: ["project"],
		compaction: { reserveTokens: 4096 },
	});
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");

	pipeline.settings.setProjectTrusted(false);

	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(pipeline.settings.getProjectSettings(), {}, "revocation must clear cached project configuration");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model", "merged settings must fall back to global values");
	assert.deepEqual(pipeline.settings.getGlobalSettings().extensions, ["global"], "global settings must be preserved");
	assert.deepEqual(pipeline.settings.getGlobalSettings().compaction, {
		reserveTokens: 8192,
		keepRecentTokens: 2000,
	});
});

// 3. Loader-driven reload with a resolver: first contact is headless and denies.
await scenario("headless reload denies trust and excludes project resources", async () => {
	const pipeline = await newPipeline();
	const mark = pipeline.events.length;
	const outcome = await pipeline.reload();
	const events = pipeline.events.slice(mark);

	assert.equal(outcome.calls, 1, "the resolver must be consulted exactly once");
	assert.ok(sawTrustPrompt(events), "the trust resolver must run during reload");
	assert.equal(pipeline.settings.isProjectTrusted(), false, "headless ask reload must leave the project untrusted");
	assert.deepEqual(namesOf(outcome), ["cli.ts", "global.ts"], "only CLI and global extensions may resolve");
	assert.deepEqual(pipeline.settings.getProjectSettings(), {}, "project configuration must not be loaded");
	assert.deepEqual(pipeline.settings.getGlobalSettings().extensions, ["global"]);
	assert.ok(resolveEvents(events).length >= 2, "bootstrap and final resolves are both observable");
	assertDeniedResolveEvents(events);
	assertNoProjectExtensionLoads(events);
});

// 4. Approval, then reload without a resolver keeps the trust state.
await scenario("reload without a resolver retains an approval and its resources", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.override = true;
	const approved = await pipeline.reload();
	assert.equal(approved.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(namesOf(approved), ["cli.ts", "global.ts", "project.ts"], "approval brings in project extensions");
	assert.deepEqual(pipeline.settings.getProjectSettings().extensions, ["project"]);

	const mark = pipeline.events.length;
	await pipeline.loader.reload();
	const events = pipeline.events.slice(mark);

	assert.ok(!sawTrustPrompt(events), "a reload without a resolver must not re-ask for trust");
	assert.equal(pipeline.settings.isProjectTrusted(), true, "trust state must be retained across a resolver-less reload");
	assert.deepEqual(loadedNames(pipeline.loader), ["cli.ts", "global.ts", "project.ts"]);
	assert.ok(resolveEvents(events).length >= 1);
	for (const [, trusted] of resolveEvents(events)) {
		assert.equal(trusted, true, "retained trust must be visible to resource resolution");
	}
});

// 5. Revocation after approval discards configuration and project resources.
await scenario("revocation after approval clears project config and extensions", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.override = true;
	await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, "precondition: previously approved");
	assert.deepEqual(loadedNames(pipeline.loader), ["cli.ts", "global.ts", "project.ts"]);

	// Revoke by recording a denial in the trust store, as the interactive/UI revoke path does.
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = false;
	const mark = pipeline.events.length;
	const revoked = await pipeline.reload();
	const events = pipeline.events.slice(mark);

	assert.equal(revoked.calls, 1);
	assert.equal(pipeline.settings.isProjectTrusted(), false, "revocation must be applied, not overwritten with trust");
	assert.deepEqual(namesOf(revoked), ["cli.ts", "global.ts"], "project extensions must leave the next resolved set");
	assert.deepEqual(loadedNames(pipeline.loader), ["cli.ts", "global.ts"]);
	assert.deepEqual(pipeline.settings.getProjectSettings(), {}, "cached project configuration must be discarded");
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(pipeline.settings.getGlobalSettings().extensions, ["global"], "global extensions are preserved");
	assert.deepEqual(pipeline.settings.getGlobalSettings().compaction, {
		reserveTokens: 8192,
		keepRecentTokens: 2000,
	});
	assert.ok(sawTrustPrompt(events), "the trust decision must be re-resolved on revocation");
	assert.ok(resolveEvents(events).length >= 2);
	assertDeniedResolveEvents(events);
	assertNoProjectExtensionLoads(events);

	const markAfterRevoke = pipeline.events.length;
	await pipeline.loader.reload();
	const afterRevoke = pipeline.events.slice(markAfterRevoke);
	assert.ok(!sawTrustPrompt(afterRevoke), "resolver-less reload must not re-prompt");
	assert.equal(pipeline.settings.isProjectTrusted(), false, "resolver-less reload must retain the revoked state");
	assert.deepEqual(loadedNames(pipeline.loader), ["cli.ts", "global.ts"]);
	assertDeniedResolveEvents(afterRevoke);
});

// 6. Revocation through an explicit override also removes project resources.
await scenario("explicit override revocation removes project resources", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.override = true;
	await pipeline.reload();
	assert.deepEqual(loadedNames(pipeline.loader), ["cli.ts", "global.ts", "project.ts"]);

	pipeline.scenario.override = false;
	const mark = pipeline.events.length;
	const revoked = await pipeline.reload();
	const events = pipeline.events.slice(mark);

	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual(namesOf(revoked), ["cli.ts", "global.ts"]);
	assert.deepEqual(pipeline.settings.getProjectSettings(), {});
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.ok(!sawTrustPrompt(events), "an explicit override resolves trust without prompting");
	assertDeniedResolveEvents(events);
});

// 7. A stored approval makes a headless reload trusted without prompting.
await scenario("stored approval allows project resources on a headless reload", async () => {
	const pipeline = await newPipeline();
	pipeline.scenario.stored = true;
	const outcome = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual(namesOf(outcome), ["cli.ts", "global.ts", "project.ts"]);
	assert.deepEqual(pipeline.settings.getProjectSettings().extensions, ["project"]);
});

console.log(`\n${results.length} scenario(s) passed`);
