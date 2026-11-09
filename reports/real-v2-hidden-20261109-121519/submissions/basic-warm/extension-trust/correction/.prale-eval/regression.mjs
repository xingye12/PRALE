/**
 * Regression for extension-trust/correction.
 *
 * Exercises the real DefaultResourceLoader.reload() lifecycle through the
 * boundary-faked subject helper. The fault was a blanket `projectTrusted =
 * false` that never invoked the supplied trust resolver, so project resources
 * could never be loaded even after a true decision.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createTrustSubject } from "./subject.mjs";

const root = process.cwd();

function pathsOf(extensionsResult) {
	return extensionsResult.extensions.map((extension) => path.basename(extension.path));
}

async function runReload(decision) {
	const subject = await createTrustSubject(root, { initialTrusted: true });
	const calls = [];
	let eventsAtResolution;
	let stateAtResolution;

	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			calls.push(extensionsResult);
			eventsAtResolution = [...subject.events];
			stateAtResolution = { trusted: subject.state.trusted, loadedTrust: subject.state.loadedTrust };
			// Deferring a microtask proves the loader awaits the asynchronous
			// decision instead of racing ahead with a hardcoded answer.
			await Promise.resolve();
			return decision;
		},
	});

	return {
		calls,
		eventsAtResolution,
		stateAtResolution,
		events: subject.events,
		loadedExtensions: pathsOf(subject.loader.getExtensions()),
	};
}

// 1. A true decision must be honored: the resolver is called exactly once,
//    observes the untrusted bootstrap result, and project resources load after.
const trusted = await runReload(true);

assert.equal(trusted.calls.length, 1, "trust resolver must be called exactly once");
const bootstrapPaths = trusted.calls[0].extensions.map((extension) => extension.path);
assert.ok(
	bootstrapPaths.includes(path.join(root, ".fixtures", "user.ts")),
	"untrusted bootstrap must still expose user extensions to the resolver",
);
assert.ok(
	!trusted.calls[0].extensions.some((extension) => extension.path.includes("project")),
	"untrusted bootstrap must not expose project extensions to the resolver",
);
assert.deepEqual(
	trusted.stateAtResolution,
	{ trusted: false, loadedTrust: false },
	"resolver must observe the untrusted bootstrap settings state",
);

const bootstrapSettingsIndex = trusted.eventsAtResolution.findLastIndex(
	(event) => event[0] === "settings" && event[1] === false,
);
const bootstrapResolveIndex = trusted.eventsAtResolution.findLastIndex(
	(event) => event[0] === "resolve" && event[1] === false,
);
assert.ok(bootstrapSettingsIndex >= 0, "bootstrap settings must reload as untrusted before resolution");
assert.ok(
	bootstrapResolveIndex > bootstrapSettingsIndex,
	"resolver must run only after package resources resolve under untrusted settings",
);
assert.ok(
	!trusted.eventsAtResolution.some((event) => event[0] === "set" && event[1] === true),
	"trust must not be granted before the resolver returns",
);
assert.ok(
	trusted.events.some((event) => event[0] === "set" && event[1] === true),
	"a true decision must be applied to the settings manager",
);
assert.ok(
	trusted.loadedExtensions.includes("project.ts"),
	"project extensions must load after a true trust decision",
);
assert.ok(
	trusted.loadedExtensions.includes("user.ts"),
	"user extensions must remain loaded after a true trust decision",
);
assert.ok(
	trusted.events.some((event) => event[0] === "resolve" && event[1] === true),
	"final package resolution must run under trusted settings after a true decision",
);
assert.ok(
	trusted.events.some((event) => event[0] === "extensions" && event[1].includes("project.ts")),
	"the final extension load must include the project extension after a true decision",
);

// 2. A false decision must remain denied (no blanket regression in either direction).
const denied = await runReload(false);

assert.equal(denied.calls.length, 1, "trust resolver must be called exactly once for a false decision");
assert.deepEqual(
	denied.stateAtResolution,
	{ trusted: false, loadedTrust: false },
	"resolver must observe the untrusted bootstrap settings state for a false decision",
);
assert.ok(
	denied.events.some((event) => event[0] === "set" && event[1] === false),
	"a false decision must be applied to the settings manager",
);
assert.ok(
	!denied.loadedExtensions.includes("project.ts"),
	"project extensions must stay unloaded after a false trust decision",
);
assert.ok(denied.loadedExtensions.includes("user.ts"), "user extensions must stay loaded after a false decision");

console.log("extension-trust regression passed");
