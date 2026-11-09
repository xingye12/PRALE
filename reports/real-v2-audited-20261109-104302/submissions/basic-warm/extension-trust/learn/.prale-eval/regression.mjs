/**
 * Regression: project extensions must not leak into the trust bootstrap.
 *
 * Bootstrap (ResourceLoader.loadProjectTrustExtensions) runs *before* project trust
 * has been decided, so it must force untrusted project settings before reloading
 * settings and resolving extensions. User/global and CLI extensions stay available.
 *
 * The fault this guards against is the bootstrap forcing trusted project settings
 * (`setProjectTrusted(true)`), which lets project-local extensions load before any
 * trust decision is made.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTrustSubject } from './subject.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Array.from rebuilds the array in this realm: extension arrays produced by the loaded
// module live in its vm realm, and cross-realm prototypes break deepStrictEqual.
const basenames = (paths) => Array.from(paths, (p) => String(p).split(/[\\/]/).pop()).sort();

function extensionNames(extensionsResult, label) {
	assert.ok(extensionsResult, `${label}: expected an extensions result, got ${extensionsResult}`);
	assert.ok(Array.isArray(extensionsResult.extensions), `${label}: expected extensions to be an array`);
	return basenames(extensionsResult.extensions.map((extension) => extension.path));
}

const eventsOf = (events, kind) => events.filter((event) => event[0] === kind);

// ---------------------------------------------------------------------------
// 1. Bootstrap forces untrusted settings even when the previous state was trusted,
//    and the pre-trust extension set excludes project extensions.
// ---------------------------------------------------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	assert.equal(state.trusted, true, 'precondition: previous settings state must be trusted');

	let bootstrapExtensions;
	let bootstrapObservedTrust;
	const finalTrust = false;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapExtensions = extensionsResult;
			// Observe what the settings/package boundary saw while bootstrap resolved extensions.
			bootstrapObservedTrust = eventsOf(events, 'resolve').map((event) => event[1]);
			return finalTrust;
		},
	});

	// The very first settings mutation of the bootstrap must force untrusted project settings.
	assert.deepEqual(
		events[0],
		['set', false],
		`bootstrap must force untrusted project settings first, got ${JSON.stringify(events[0])} (events: ${JSON.stringify(events)})`,
	);

	// Extension resolution during bootstrap must have happened with untrusted settings.
	assert.ok(
		bootstrapObservedTrust.length > 0,
		'bootstrap must resolve extensions before the trust decision is returned',
	);
	assert.ok(
		bootstrapObservedTrust.every((trusted) => trusted === false),
		`bootstrap must resolve extensions with untrusted settings, saw trust states ${JSON.stringify(bootstrapObservedTrust)}`,
	);

	// Project extensions are excluded from the pre-trust set; user/global and CLI stay.
	const bootstrapNames = extensionNames(bootstrapExtensions, 'bootstrap extensions');
	assert.ok(
		!bootstrapNames.includes('project.ts'),
		`project extension leaked into trust bootstrap: ${JSON.stringify(bootstrapNames)}`,
	);
	assert.ok(
		bootstrapNames.includes('user.ts'),
		`user/global extension must remain available during bootstrap, saw ${JSON.stringify(bootstrapNames)}`,
	);
	assert.ok(
		bootstrapNames.includes('cli.ts'),
		`CLI extension must remain available during bootstrap, saw ${JSON.stringify(bootstrapNames)}`,
	);

	// Bootstrap must not silently leave the settings forced untrusted: the trust decision
	// is applied afterwards and the final load reflects it.
	assert.deepEqual(
		eventsOf(events, 'set').map((event) => event[1]),
		[false, finalTrust],
		`trust decisions must be: forced untrusted bootstrap, then the resolved decision; events: ${JSON.stringify(events)}`,
	);

	const finalNames = extensionNames(loader.getExtensions(), 'final extensions');
	assert.ok(
		!finalNames.includes('project.ts'),
		`declined trust must keep project extensions out, saw ${JSON.stringify(finalNames)}`,
	);
	assert.deepEqual(
		finalNames,
		['cli.ts', 'user.ts'],
		`final set for declined trust must be user + CLI extensions, saw ${JSON.stringify(finalNames)}`,
	);
	assert.equal(state.trusted, finalTrust, 'the resolved trust decision must be stored');
}

// ---------------------------------------------------------------------------
// 2. Approving trust afterwards still loads project extensions — the bootstrap
//    pass is read-only with respect to the final trust state.
// ---------------------------------------------------------------------------
{
	const { loader, events } = await createTrustSubject(root, { initialTrusted: true });

	let bootstrapNames;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = extensionNames(extensionsResult, 'bootstrap extensions (approved)');
			return true;
		},
	});

	assert.ok(
		!bootstrapNames.includes('project.ts'),
		`project extension leaked into trust bootstrap before approval: ${JSON.stringify(bootstrapNames)}`,
	);

	const finalNames = extensionNames(loader.getExtensions(), 'final extensions (approved)');
	assert.ok(
		finalNames.includes('project.ts'),
		`approved trust must load project extensions, saw ${JSON.stringify(finalNames)}`,
	);
	assert.deepEqual(
		finalNames,
		['cli.ts', 'project.ts', 'user.ts'],
		`final set for approved trust must be user + project + CLI, saw ${JSON.stringify(finalNames)}`,
	);
	assert.deepEqual(
		eventsOf(events, 'set').map((event) => event[1]),
		[false, true],
		`approved trust must be applied after a forced-untrusted bootstrap; events: ${JSON.stringify(events)}`,
	);
}

// ---------------------------------------------------------------------------
// 3. A direct bootstrap pass (the public lifecycle entry point) is untrusted too.
// ---------------------------------------------------------------------------
{
	const { loader, events } = await createTrustSubject(root, { initialTrusted: true });

	const bootstrap = await loader.loadProjectTrustExtensions();
	const names = extensionNames(bootstrap, 'direct bootstrap extensions');
	assert.deepEqual(
		names,
		['cli.ts', 'user.ts'],
		`direct bootstrap must load only user/CLI extensions, saw ${JSON.stringify(names)}`,
	);
	assert.ok(!names.includes('project.ts'), 'direct bootstrap must not load project extensions');
	assert.deepEqual(
		events[0],
		['set', false],
		`direct bootstrap must force untrusted settings, got ${JSON.stringify(events[0])} (events: ${JSON.stringify(events)})`,
	);

	// A second call from an already-untrusted state must still be untrusted and idempotent.
	const again = await loader.loadProjectTrustExtensions();
	const againNames = extensionNames(again, 'second direct bootstrap extensions');
	assert.ok(!againNames.includes('project.ts'), 'second bootstrap must not load project extensions');
	assert.ok(againNames.includes('user.ts'), 'second bootstrap must keep user extensions available');
	assert.ok(againNames.includes('cli.ts'), 'second bootstrap must keep CLI extensions available');
}

console.log('ok: trust bootstrap forces untrusted settings and excludes project extensions');
