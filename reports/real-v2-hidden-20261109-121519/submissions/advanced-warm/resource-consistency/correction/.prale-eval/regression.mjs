/**
 * Resource-consistency regression: real project-trust resolver, real resource
 * loader and real SettingsManager are linked by subject.mjs. Only the trust
 * store, extension event delivery, package resolution and extension loading
 * are faked, so assertions span the actual module boundaries.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createResourcePipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionNames = (pipeline) =>
	Array.from(pipeline.loader.getExtensions().extensions, (extension) => path.basename(extension.path)).sort();
const resolveEvents = (pipeline) =>
	pipeline.events.filter((event) => Array.isArray(event) && event[0] === "resolve");
const loadEvents = (pipeline) =>
	pipeline.events.filter((event) => Array.isArray(event) && event[0] === "load");
const plain = (value) => (Array.isArray(value) ? Array.from(value, plain) : value);

async function scenario(extension) {
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.extension = extension;
	return pipeline;
}

// 1. A session-only approval (remember omitted) grants access for this reload,
//    but it must not write consent. The bootstrap pass must be untrusted and
//    project settings/extensions may only appear after the resolver decides.
{
	const pipeline = await scenario({ trusted: "yes" });
	const globalBefore = pipeline.storageData.global;
	const { calls, names } = await pipeline.reload();

	assert.equal(calls, 1, "resolver must run exactly once after the untrusted bootstrap");
	assert.deepEqual(
		plain(resolveEvents(pipeline)[0]),
		["resolve", false, "global-model"],
		"the bootstrap resolve must see an untrusted project and global-only settings",
	);
	assert.deepEqual(
		plain(loadEvents(pipeline)[0][1]),
		["cli.ts", "global.ts"],
		"the bootstrap must not load project-local extensions",
	);
	assert.deepEqual(plain(names), ["cli.ts", "global.ts", "project.ts"]);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(pipeline.consentWrites, [], "session-only approval must not persist consent");
	assert.equal(pipeline.storageData.global, globalBefore, "global settings storage must not change");
	assert.equal(pipeline.settings.getGlobalSettings().defaultModel, "global-model");
	assert.ok(
		pipeline.events.some((event) => Array.isArray(event) && event[0] === "extension-decision"),
		"the extension decision must be consulted",
	);
	console.log("ok 1 - session-only approval reloads project settings without persisting");
}

// 2. A session-only denial must deny access without persisting anything, and
//    without ever letting project settings or extensions leak into the reload.
{
	const pipeline = await scenario({ trusted: "no" });
	const globalBefore = pipeline.storageData.global;
	const { calls, names } = await pipeline.reload();

	assert.equal(calls, 1, "resolver must run exactly once after the untrusted bootstrap");
	assert.deepEqual(plain(resolveEvents(pipeline)[0]), ["resolve", false, "global-model"]);
	assert.deepEqual(plain(resolveEvents(pipeline).at(-1)), ["resolve", false, "global-model"]);
	assert.deepEqual(plain(names), ["cli.ts", "global.ts"], "denied projects must stay project-resource free");
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(pipeline.settings.getProjectSettings(), {});
	assert.deepEqual(pipeline.consentWrites, [], "session-only denial must not persist consent");
	assert.equal(pipeline.storageData.global, globalBefore, "global settings storage must not change");
	console.log("ok 2 - session-only denial stays closed without persisting");
}

// 3. Remembering an extension decision is opt-in: remember === true persists,
//    and the persisted value follows the approval/denial decision.
{
	const approved = await scenario({ trusted: "yes", remember: true });
	await approved.reload();
	assert.deepEqual(plain(approved.consentWrites), [[root, true]], "explicit remember must persist approval");

	const denied = await scenario({ trusted: "no", remember: true });
	await denied.reload();
	assert.deepEqual(plain(denied.consentWrites), [[root, false]], "explicit remember must persist denial");
	console.log("ok 3 - explicit remember persists the extension decision in both directions");
}

// 4. Explicit remember === false is still session-only; it must not be treated
//    as an implicit request to persist the decision.
{
	const approved = await scenario({ trusted: "yes", remember: false });
	await approved.reload();
	assert.deepEqual(approved.consentWrites, [], "remember:false must not persist approval");

	const denied = await scenario({ trusted: "no", remember: false });
	await denied.reload();
	assert.deepEqual(denied.consentWrites, [], "remember:false must not persist denial");
	console.log("ok 4 - remember:false never persists consent");
}

// 5. Toggling trust on a live loader must reload project settings each way.
{
	const pipeline = await scenario({ trusted: "yes" });
	let result = await pipeline.reload();
	assert.equal(result.calls, 1);
	assert.deepEqual(extensionNames(pipeline), ["cli.ts", "global.ts", "project.ts"]);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");

	pipeline.scenario.extension = { trusted: "no" };
	result = await pipeline.reload();
	assert.equal(result.calls, 1, "each reload resolves trust exactly once");
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts"], "revoking trust must unload project resources");

	pipeline.scenario.extension = { trusted: "yes", remember: true };
	result = await pipeline.reload();
	assert.equal(result.calls, 1, "each reload resolves trust exactly once");
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.deepEqual(plain(result.names), ["cli.ts", "global.ts", "project.ts"]);
	assert.deepEqual(plain(pipeline.consentWrites), [[root, true]]);
	console.log("ok 5 - changing trust reloads project settings in both directions");
}

// 6. The SettingsManager itself must reload project settings when trust flips,
//    independent of the loader, and must not touch global configuration.
{
	const pipeline = await createResourcePipeline(root);
	const globalBefore = pipeline.storageData.global;
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");

	pipeline.settings.setProjectTrusted(false);
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.equal(pipeline.settings.getDefaultModel(), "global-model");
	assert.deepEqual(pipeline.settings.getProjectSettings(), {});

	pipeline.settings.setProjectTrusted(true);
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.equal(pipeline.settings.getDefaultModel(), "project-model");
	assert.equal(pipeline.settings.getGlobalSettings().defaultModel, "global-model");
	assert.equal(pipeline.storageData.global, globalBefore);
	console.log("ok 6 - SettingsManager reloads project settings on trust changes only");
}

console.log("resource-consistency regression passed");
