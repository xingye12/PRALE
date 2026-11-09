/**
 * Regression for extension-trust/correction.
 *
 * The resource loader must consult the project trust resolver exactly once during the
 * bootstrap pass, must hand it the untrusted bootstrap extension set, and must preserve
 * the resolver's asynchronous ordering (no trust flip or project resource load may happen
 * until the resolver's promise settles). A `true` decision then admits project resources;
 * a `false` decision keeps denying them.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Extensions come from a VM realm, so normalize into host arrays before comparing.
const basenames = (extensions) => Array.from(extensions, (extension) => path.basename(extension.path));
const describeEvents = (events) => events.map((event) => JSON.stringify(event)).join(" | ");

// ---------------------------------------------------------------------------------------
// A true decision is honored: the resolver is called once with the untrusted bootstrap set,
// settles before trust is applied, and project extensions are loaded afterwards.
// ---------------------------------------------------------------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	const resolverCalls = [];
	const observed = [];

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls.push(extensionsResult);
			observed.push({
				phase: "enter",
				trusted: state.trusted,
				loadedTrust: state.loadedTrust,
				extensions: basenames(extensionsResult.extensions),
				events: describeEvents([...events]),
			});
			// Defer the decision so any eager trust flip or project load is observable.
			await new Promise((resolve) => setTimeout(resolve, 10));
			observed.push({
				phase: "settle",
				trusted: state.trusted,
				loadedTrust: state.loadedTrust,
				events: describeEvents([...events]),
			});
			return true;
		},
	});

	assert.equal(resolverCalls.length, 1, "project trust resolver must be consulted exactly once");

	const entry = observed[0];
	assert.ok(
		!entry.extensions.includes("project.ts"),
		`resolver must observe the untrusted bootstrap extension set (no project extension), got ${JSON.stringify(entry.extensions)}; events: ${entry.events}`,
	);
	assert.deepEqual(
		entry.extensions,
		["cli.ts", "user.ts"],
		`bootstrap must still include user/global and temporary CLI extensions, got ${JSON.stringify(entry.extensions)}; events: ${entry.events}`,
	);
	assert.equal(entry.trusted, false, "project must be untrusted while the bootstrap resolver runs");
	assert.equal(entry.loadedTrust, false, "bootstrap settings must be reloaded as untrusted before resolving");
	assert.ok(
		!entry.events.includes('["resolve",true]') && !entry.events.includes('["extensions",["cli.ts","project.ts"]]'),
		`no project resource resolution may precede the trust decision; events: ${entry.events}`,
	);

	const settle = observed[1];
	assert.equal(settle.trusted, false, "trust must not be applied before the resolver promise settles");
	assert.equal(settle.loadedTrust, false, "settings must not be reloaded with resolved trust before the resolver settles");
	assert.ok(
		!settle.events.includes('["set",true]'),
		`trust must not be stored while the resolver is still pending; events: ${settle.events}`,
	);

	const resolvedExtensions = basenames(loader.getExtensions().extensions);
	assert.ok(
		resolvedExtensions.includes("project.ts"),
		`a true trust decision must admit project resources, got ${JSON.stringify(resolvedExtensions)}; events: ${describeEvents(events)}`,
	);
	assert.ok(
		resolvedExtensions.includes("user.ts"),
		`user resources must remain loaded after a true decision, got ${JSON.stringify(resolvedExtensions)}`,
	);
	assert.equal(state.trusted, true, "the resolved trust decision must be persisted on the settings manager");
}

// ---------------------------------------------------------------------------------------
// A false decision is honored: project extensions stay denied and the resolver still runs once.
// ---------------------------------------------------------------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	let calls = 0;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			calls += 1;
			assert.deepEqual(
				basenames(extensionsResult.extensions),
				["cli.ts", "user.ts"],
				`resolver must observe the untrusted bootstrap extension set, got ${JSON.stringify(basenames(extensionsResult.extensions))}`,
			);
			assert.equal(state.trusted, false, "project must be untrusted while the bootstrap resolver runs");
			await Promise.resolve();
			return false;
		},
	});

	assert.equal(calls, 1, "project trust resolver must be consulted exactly once");
	const resolvedExtensions = basenames(loader.getExtensions().extensions);
	assert.deepEqual(
		resolvedExtensions.filter((name) => name === "project.ts"),
		[],
		`a false trust decision must deny project resources, got ${JSON.stringify(resolvedExtensions)}; events: ${describeEvents(events)}`,
	);
	assert.ok(resolvedExtensions.includes("user.ts"), `user resources must still load, got ${JSON.stringify(resolvedExtensions)}`);
	assert.equal(state.trusted, false, "the false trust decision must be persisted on the settings manager");
}

// ---------------------------------------------------------------------------------------
// Without a trust resolver the loader must not invent a trust decision of its own.
// ---------------------------------------------------------------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload();
	assert.equal(state.trusted, true, "reload without a resolver must leave trust untouched");
	const resolvedExtensions = basenames(loader.getExtensions().extensions);
	assert.ok(
		resolvedExtensions.includes("project.ts"),
		`reload without a resolver must keep the existing trusted resources, got ${JSON.stringify(resolvedExtensions)}; events: ${describeEvents(events)}`,
	);
}

console.log("extension-trust/correction regression passed");
