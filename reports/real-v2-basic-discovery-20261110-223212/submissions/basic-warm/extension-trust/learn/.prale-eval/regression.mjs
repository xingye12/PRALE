/**
 * Regression: project extensions must not leak into the project-trust bootstrap.
 *
 * `DefaultResourceLoader.reload({ resolveProjectTrust })` first performs a bootstrap pass
 * with forced *untrusted* project settings, then resolves trust, then reloads. The previous
 * on-disk state may already be "trusted", so the bootstrap pass must actively force
 * untrusted settings instead of assuming the current state is untrusted.
 *
 * Exercises the real `packages/coding-agent/src/core/resource-loader.ts` through the
 * read-only `.prale-eval/subject.mjs` boundary fakes.
 */
import assert from "node:assert/strict";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createTrustSubject } = await import(new URL("./subject.mjs", import.meta.url).href);

// Extensions come from the reloaded module's realm, so normalize into plain host arrays
// before comparing (realm-specific Array.prototype would fail deep equality checks).
const extensionNames = (extensions) =>
	Array.from(extensions, (extension) => basename(String(extension.path))).sort();

// ---------------------------------------------------------------------------
// Scenario 1: previous state was trusted, trust resolution approves the project.
// The bootstrap pass must still be untrusted: only user/global (and CLI) extensions
// may be visible to the trust resolver, and project extensions load only afterwards.
// ---------------------------------------------------------------------------
{
	const { loader, events, state, paths } = await createTrustSubject(root, { initialTrusted: true });
	let bootstrapNames;
	let resolveCalls = 0;
	let trustedAtResolution;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolveCalls += 1;
			bootstrapNames = extensionNames(extensionsResult.extensions);
			trustedAtResolution = state.loadedTrust;
			return true;
		},
	});

	assert.equal(resolveCalls, 1, "trust resolver must run exactly once per reload");

	// Core invariant: a previously-trusted state must not leak project extensions into the
	// trust bootstrap pass.
	assert.equal(
		bootstrapNames.includes("project.ts"),
		false,
		`bootstrap pass leaked project extensions into trust resolution: ${JSON.stringify(bootstrapNames)}`,
	);
	assert.deepEqual(
		bootstrapNames,
		["cli.ts", "user.ts"],
		`bootstrap must load user/global and CLI extensions only, saw ${JSON.stringify(bootstrapNames)}`,
	);
	assert.equal(
		trustedAtResolution,
		false,
		"settings loaded for the bootstrap pass must be untrusted even when the previous state was trusted",
	);

	// The forced-untrusted state must be applied explicitly (set + settings reload) before
	// the bootstrap extension resolution, whatever the prior state was.
	const firstSetIndex = events.findIndex((event) => event[0] === "set");
	assert.ok(firstSetIndex >= 0, `expected an explicit project trust write, events: ${JSON.stringify(events)}`);
	assert.deepEqual(
		[...events[firstSetIndex]],
		["set", false],
		"bootstrap must force project trust to false before reloading settings",
	);
	assert.equal(
		events[firstSetIndex][1],
		false,
		"bootstrap must force project trust to false even when the previous state was trusted",
	);

	const firstResolveIndex = events.findIndex((event) => event[0] === "resolve");
	assert.ok(firstResolveIndex > firstSetIndex, "trust must be forced before extensions are resolved");
	assert.equal(
		events[firstResolveIndex][1],
		false,
		`bootstrap extension resolution must observe untrusted settings, events: ${JSON.stringify(events)}`,
	);

	// The bootstrap extension load must not include the project extension.
	const trustedSetIndex = events.findIndex((event) => event[0] === "set" && event[1] === true);
	const bootstrapLoadIndex = events.findIndex(
		(event, index) => event[0] === "extensions" && (trustedSetIndex === -1 || index < trustedSetIndex),
	);
	assert.ok(bootstrapLoadIndex >= 0, `expected a bootstrap extension load, events: ${JSON.stringify(events)}`);
	assert.deepEqual(
		[...events[bootstrapLoadIndex][1]].sort(),
		["cli.ts", "user.ts"],
		`bootstrap extension load must exclude project extensions, saw ${JSON.stringify(events[bootstrapLoadIndex][1])}`,
	);

	// After trust is approved the project extension loads in the final pass, and user/CLI
	// extensions stay available.
	const finalNames = extensionNames(loader.getExtensions().extensions);
	assert.deepEqual(
		finalNames,
		["cli.ts", "project.ts", "user.ts"],
		`trusted final reload must load user, project and CLI extensions, saw ${JSON.stringify(finalNames)}`,
	);
	assert.equal(
		finalNames.includes(basename(paths.user)),
		true,
		"user/global extensions must remain available after trust resolution",
	);
	assert.equal(
		finalNames.includes(basename(paths.cli)),
		true,
		"CLI extensions must remain available after trust resolution",
	);
	assert.equal(loader.getExtensions().errors.length, 0, "no extension load errors expected");
}

// ---------------------------------------------------------------------------
// Scenario 2: previous state was untrusted and trust resolution rejects the project.
// The bootstrap pass must be untrusted too, and the project extension must stay out of
// the final set while user/global and CLI extensions remain available.
// ---------------------------------------------------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: false });
	let bootstrapNames;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = extensionNames(extensionsResult.extensions);
			assert.equal(state.loadedTrust, false, "bootstrap settings must be untrusted while trust is unresolved");
			return false;
		},
	});

	assert.deepEqual(
		bootstrapNames,
		["cli.ts", "user.ts"],
		`untrusted bootstrap must load user/CLI extensions only, saw ${JSON.stringify(bootstrapNames)}`,
	);

	const finalNames = extensionNames(loader.getExtensions().extensions);
	assert.deepEqual(
		finalNames,
		["cli.ts", "user.ts"],
		`a rejected project must not load project extensions, saw ${JSON.stringify(finalNames)}`,
	);
	assert.equal(
		events.some((event) => event[0] === "set" && event[1] === false),
		true,
		`expected an explicit untrusted write, events: ${JSON.stringify(events)}`,
	);
}

console.log("regression: project extensions no longer leak into the trust bootstrap");
