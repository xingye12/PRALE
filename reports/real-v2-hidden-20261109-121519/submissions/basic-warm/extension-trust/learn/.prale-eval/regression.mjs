/**
 * Regression for extension-trust/learn.
 *
 * Trust bootstrap must force project trust OFF before reloading settings and
 * resolving extensions, even when the previously persisted state was trusted.
 * The bootstrap pass may only expose user/global and temporary CLI extensions;
 * project-local extensions must not be resolved or loaded before trust is
 * established. Once trust resolves to `true`, the final reload may include
 * project extensions again, while a plain reload (no trust bootstrap) keeps
 * honoring the current trust state.
 *
 * Exercises the real DefaultResourceLoader.reload/loadProjectTrustExtensions
 * production code through the boundary fakes exported by subject.mjs.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createTrustSubject } from "./subject.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// Values crossing the vm boundary come from another realm; rebuild them as
// plain host-realm arrays so strict deep equality compares structure only.
const plain = (value) => (Array.isArray(value) ? Array.from(value, plain) : value);
const names = (extensions) => Array.from(extensions, (extension) => path.basename(extension.path)).sort();
const extensionNames = (loader) => names(loader.getExtensions().extensions);

// ---------------------------------------------------------------------------
// 1. A previously trusted project must still bootstrap untrusted, then gain
//    project extensions only after the trust resolver approves it.
// ---------------------------------------------------------------------------
{
	const { loader, events, state } = await createTrustSubject(ROOT, { initialTrusted: true });
	let bootstrapNames;
	let bootstrapTrusted;
	let bootstrapLoadedTrust;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = names(extensionsResult.extensions);
			bootstrapTrusted = state.trusted;
			bootstrapLoadedTrust = state.loadedTrust;
			return true;
		},
	});

	assert.deepEqual(
		bootstrapNames,
		["cli.ts", "user.ts"],
		"bootstrap must expose user/global and CLI extensions but no project extension",
	);
	assert.equal(bootstrapTrusted, false, "project trust must be forced off during the bootstrap pass");
	assert.equal(
		bootstrapLoadedTrust,
		false,
		"settings must be reloaded as untrusted before extensions are resolved",
	);

	// Ordering: force untrusted -> reload settings -> resolve extensions.
	assert.deepEqual(plain(events[0]), ["set", false], "bootstrap must set project trust to false first");
	assert.deepEqual(plain(events[1]), ["settings", false], "bootstrap must reload settings as untrusted");
	assert.deepEqual(plain(events[2]), ["resolve", false], "extension resolution must observe untrusted settings");
	assert.deepEqual(
		plain(events[3]),
		["extensions", ["cli.ts", "user.ts"]],
		"bootstrap extension load must only contain user/global and CLI extensions",
	);

	// The resolved trust is applied afterwards and only then admits project code.
	assert.deepEqual(extensionNames(loader), ["cli.ts", "project.ts", "user.ts"]);
	assert.equal(state.trusted, true, "resolved trust must be applied after the bootstrap pass");
	assert.deepEqual(plain(events.at(-4)), ["set", true], "resolved project trust must be restored");
	assert.deepEqual(plain(events.at(-3)), ["settings", true], "final settings reload must use resolved trust");
	assert.deepEqual(plain(events.at(-2)), ["resolve", true], "final resolution must observe resolved trust");
	assert.deepEqual(
		plain(events.at(-1)),
		["extensions", ["project.ts"]],
		"only extensions skipped during the untrusted bootstrap may load after trust is granted",
	);
}

// ---------------------------------------------------------------------------
// 2. An untrusted project stays untrusted: no project extension at any point.
// ---------------------------------------------------------------------------
{
	const { loader, state } = await createTrustSubject(ROOT, { initialTrusted: false });
	let bootstrapNames;
	let bootstrapTrusted;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = names(extensionsResult.extensions);
			bootstrapTrusted = state.trusted;
			return false;
		},
	});

	assert.equal(bootstrapTrusted, false, "bootstrap must keep project trust off");
	assert.deepEqual(bootstrapNames, ["cli.ts", "user.ts"], "bootstrap must not load project extensions");
	assert.equal(state.trusted, false, "declined trust must remain off");
	assert.deepEqual(
		extensionNames(loader),
		["cli.ts", "user.ts"],
		"declined trust must not load project extensions in the final set",
	);
}

// ---------------------------------------------------------------------------
// 3. Reloads without a trust bootstrap keep honoring the current trust state,
//    so the fix must not force project trust off unconditionally.
// ---------------------------------------------------------------------------
{
	const trusted = await createTrustSubject(ROOT, { initialTrusted: true });
	await trusted.loader.reload();
	assert.deepEqual(
		extensionNames(trusted.loader),
		["cli.ts", "project.ts", "user.ts"],
		"a trusted project keeps its extensions on a plain reload",
	);

	const untrusted = await createTrustSubject(ROOT, { initialTrusted: false });
	await untrusted.loader.reload();
	assert.deepEqual(
		extensionNames(untrusted.loader),
		["cli.ts", "user.ts"],
		"an untrusted project still excludes project extensions on a plain reload",
	);
}

console.log("extension-trust/learn regression: ok");
