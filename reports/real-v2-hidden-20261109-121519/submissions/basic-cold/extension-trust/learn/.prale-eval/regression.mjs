/**
 * Regression for extension-trust/learn: project extensions must not leak into the
 * project-trust bootstrap pass.
 *
 * The trust bootstrap in DefaultResourceLoader must force the settings manager into the
 * untrusted state *before* reloading settings and resolving extensions, otherwise a
 * previously-trusted state lets project-local extensions load before trust has been
 * decided (i.e. project code runs before the user grants trust). User/global and
 * temporary CLI extensions must keep loading during that pass.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { createTrustSubject } from "./subject.mjs";

const root = process.cwd();

/** Event helpers over the recorded settings/package-manager boundary calls. */
// VM-context values arrive with foreign array prototypes, so normalize to host arrays.
const host = (iterable) => Array.from(iterable);
const pick = (events, kind) => host(events.filter((e) => e[0] === kind).map((e) => e[1]));
const sets = (events) => pick(events, "set");
const settingsReloads = (events) => pick(events, "settings");
const resolves = (events) => pick(events, "resolve");
const loadBatches = (events) => pick(events, "extensions");
const basenames = (entries) => host(entries).map((file) => String(file).split("/").pop()).sort();
const finalExtensions = (loader) => basenames(loader.getExtensions().extensions.map((e) => e.path));

/**
 * Core invariant: up to and including the first extension resolve, the settings manager must
 * never be trusted. Trust may only be granted after the trust resolver has decided.
 */
function assertUntrustedBootstrap(events, label) {
	const firstResolve = events.findIndex((e) => e[0] === "resolve");
	assert.ok(firstResolve > 0, `${label}: extensions must be resolved during bootstrap`);
	const beforeResolve = events.slice(0, firstResolve);
	const setsBefore = beforeResolve.filter((e) => e[0] === "set").map((e) => e[1]);
	const reloadsBefore = beforeResolve.filter((e) => e[0] === "settings").map((e) => e[1]);

	assert.ok(
		setsBefore.length > 0,
		`${label}: bootstrap must force the project trust setting before reloading settings and resolving extensions`,
	);
	assert.ok(
		setsBefore.every((value) => value === false),
		`${label}: bootstrap must force untrusted settings before resolving extensions, saw setProjectTrusted(${JSON.stringify(setsBefore)})`,
	);
	assert.ok(
		reloadsBefore.length > 0 && reloadsBefore.every((value) => value === false),
		`${label}: settings must be reloaded untrusted before resolving extensions, saw trusted=${JSON.stringify(reloadsBefore)}`,
	);
	assert.equal(
		resolves(events)[0],
		false,
		`${label}: extensions must be resolved untrusted during bootstrap, first resolve saw trusted=${resolves(events)[0]}`,
	);
	assert.ok(
		!loadBatches(events)[0].includes("project.ts"),
		`${label}: project extension leaked into trust bootstrap: ${JSON.stringify(loadBatches(events)[0])}`,
	);
	assert.deepEqual(
		basenames(loadBatches(events)[0]),
		["cli.ts", "user.ts"],
		`${label}: bootstrap extensions must be user/global + CLI only, got ${JSON.stringify(loadBatches(events)[0])}`,
	);
}

const results = [];

async function scenario(name, fn) {
	const detail = await fn();
	results.push(`${name}: ${detail}`);
}

// 1. The reported failure: the previous state was trusted, then bootstrap runs.
//    The bootstrap pass must observe untrusted settings before resolving extensions.
await scenario("bootstrap forces untrusted even when previous state was trusted", async () => {
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	const seenByTrustResolver = [];
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			seenByTrustResolver.push(basenames(extensionsResult.extensions.map((e) => e.path)));
			return true;
		},
	});

	// Bootstrap must run fully untrusted: settings forced, reloaded, and resolved untrusted.
	assertUntrustedBootstrap(events, "trusted-start reload");

	// The trust resolver may only see untrusted-visible (user/global + CLI) extensions.
	assert.deepEqual(
		seenByTrustResolver[0],
		["cli.ts", "user.ts"],
		"trust resolver must only see untrusted-visible (user/global + CLI) extensions",
	);

	// After trust is granted, project extensions load in the final set.
	assert.deepEqual(
		finalExtensions(loader),
		["cli.ts", "project.ts", "user.ts"],
		"trusted final extension set must include project extensions alongside user/global and CLI ones",
	);
	assert.equal(state.trusted, true, "settings must end up trusted after the trust resolver approves");
	assert.equal(sets(events).at(-1), true, "the resolved trust value must be applied after the bootstrap pass");
	return "bootstrap reloaded settings untrusted, resolved user+CLI only, then loaded project once trusted";
});

// 2. A denied trust decision must keep the project extension unloaded for the whole run.
await scenario("denied trust keeps project extensions unloaded", async () => {
	const { loader, events } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload({ resolveProjectTrust: async () => false });

	assertUntrustedBootstrap(events, "denied reload");
	assert.ok(
		resolves(events).every((value) => value === false),
		`every extension resolution must run untrusted when trust is denied, saw ${JSON.stringify(resolves(events))}`,
	);
	for (const batch of loadBatches(events)) {
		assert.ok(!batch.includes("project.ts"), `project extension loaded despite denied trust: ${JSON.stringify(batch)}`);
	}
	assert.deepEqual(
		finalExtensions(loader),
		["cli.ts", "user.ts"],
		"denied trust must leave only user/global and CLI extensions loaded",
	);
	return "project extension never loaded when trust was denied";
});

// 3. Previously-untrusted state behaves identically (forcing must not depend on prior state).
await scenario("previously untrusted state also bootstraps untrusted", async () => {
	const { loader, events } = await createTrustSubject(root, { initialTrusted: false });
	await loader.reload({ resolveProjectTrust: async () => true });

	assertUntrustedBootstrap(events, "untrusted-start reload");
	assert.deepEqual(
		finalExtensions(loader),
		["cli.ts", "project.ts", "user.ts"],
		"granted trust must load project extensions afterwards",
	);
	return "untrusted start bootstraps untrusted and still loads project extensions once trusted";
});

// 4. The standalone bootstrap entry point (used by the CLI trust prompt) is equally safe.
await scenario("loadProjectTrustExtensions bootstraps untrusted", async () => {
	const { loader, events } = await createTrustSubject(root, { initialTrusted: true });
	const extensionsResult = await loader.loadProjectTrustExtensions();

	assertUntrustedBootstrap(events, "loadProjectTrustExtensions");
	assert.deepEqual(
		basenames(extensionsResult.extensions.map((e) => e.path)),
		["cli.ts", "user.ts"],
		`bootstrap extension set must exclude project extensions, got ${JSON.stringify(basenames(extensionsResult.extensions.map((e) => e.path)))}`,
	);
	return "direct bootstrap call excluded project extensions while keeping user/CLI ones";
});

for (const line of results) console.log(`ok - ${line}`);
console.log(`regression passed (${results.length} scenarios)`);
