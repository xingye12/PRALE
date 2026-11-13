/**
 * Regression for extension-trust/correction.
 *
 * Exercises the real DefaultResourceLoader.reload() project-trust lifecycle:
 *  - the bootstrap pass must run untrusted and be handed to the resolver,
 *  - the resolver must be consulted exactly once per reload,
 *  - a `true` decision must allow project extensions,
 *  - a `false` decision must deny project extensions,
 *  - the resolver's asynchronous result must be awaited before the trusted
 *    settings reload / package resolution happens.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = (p) => path.basename(p);

// 1. Trusted decision: bootstrap is untrusted, resolver is called once with the
//    bootstrap result, project resources are then allowed.
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	let resolverCalls = 0;
	let resolvedProjectTrust = false;

	const reload = loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls += 1;
			events.push(["resolver:start"]);
			// The bootstrap pass must already be complete and untrusted.
			assert.equal(state.loadedTrust, false, "bootstrap package resolution must be untrusted");
			const bootstrapNames = Array.from(extensionsResult.extensions, (extension) => base(extension.path));
			assert.ok(
				bootstrapNames.includes("user.ts"),
				`bootstrap must include user extension, got ${JSON.stringify(bootstrapNames)}`,
			);
			assert.ok(
				!bootstrapNames.includes("project.ts"),
				`bootstrap must exclude project extension, got ${JSON.stringify(bootstrapNames)}`,
			);
			assert.deepEqual(bootstrapNames, ["cli.ts", "user.ts"], "bootstrap extension set");
			assert.ok(Array.isArray(extensionsResult.errors), "bootstrap result carries errors");
			// Make the resolver genuinely asynchronous so ordering is observable.
			await new Promise((resolve) => setTimeout(resolve, 5));
			events.push(["resolver:end"]);
			resolvedProjectTrust = true;
			return true;
		},
	});
	await reload;

	assert.equal(resolverCalls, 1, "trust resolver must be consulted exactly once");
	assert.equal(resolvedProjectTrust, true, "resolver decision was awaited");
	assert.equal(state.trusted, true, "resolver decision must be applied to project trust");

	const names = Array.from(loader.getExtensions().extensions, (extension) => base(extension.path));
	assert.deepEqual(
		names,
		["cli.ts", "user.ts", "project.ts"],
		"a true trust decision must allow project resources",
	);

	const order = events.map((event) => event[0]);
	const resolverStart = order.indexOf("resolver:start");
	const resolverEnd = order.indexOf("resolver:end");
	assert.notEqual(resolverStart, -1, "resolver must be consulted");
	assert.ok(resolverStart < resolverEnd, "resolver must run to completion");
	const untrustedBootstrap = events.findIndex((event) => event[0] === "settings" && event[1] === false);
	assert.notEqual(untrustedBootstrap, -1, "bootstrap settings reload must be untrusted");
	assert.ok(untrustedBootstrap < resolverStart, "resolver must observe the untrusted bootstrap");
	const trustedReload = events.findIndex((event) => event[0] === "settings" && event[1] === true);
	assert.notEqual(trustedReload, -1, "trusted settings reload must happen");
	assert.ok(resolverEnd < trustedReload, "trusted settings reload must wait for the resolver");
	assert.deepEqual(
		events.filter((event) => event[0] === "resolve"),
		[
			["resolve", false],
			["resolve", true],
		],
		"package resolution must be untrusted before the resolver and trusted after it",
	);
}

// 2. Untrusted decision: project resources stay denied even when the session
//    started trusted, and the resolver is still consulted exactly once.
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	let resolverCalls = 0;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls += 1;
			assert.equal(state.loadedTrust, false, "bootstrap must stay untrusted for the resolver");
			assert.ok(
				!extensionsResult.extensions.some((extension) => base(extension.path) === "project.ts"),
				"bootstrap must not expose project extensions",
			);
			await Promise.resolve();
			return false;
		},
	});

	assert.equal(resolverCalls, 1, "trust resolver must be consulted exactly once");
	assert.equal(state.trusted, false, "a false decision must be applied to project trust");

	const names = Array.from(loader.getExtensions().extensions, (extension) => base(extension.path));
	assert.deepEqual(names, ["cli.ts", "user.ts"], "a false trust decision must deny project resources");
	assert.ok(
		events.some((event) => event[0] === "resolve" && event[1] === false),
		"final package resolution must remain untrusted",
	);
}

console.log("extension-trust/correction regression: passed");
