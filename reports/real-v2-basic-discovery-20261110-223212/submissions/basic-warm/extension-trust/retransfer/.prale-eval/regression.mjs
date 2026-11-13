/**
 * Regression: a denied project-trust decision must not be upgraded to approval.
 *
 * Exercises the real DefaultResourceLoader.reload() through the boundary fakes
 * provided by subject.mjs. The buggy version unconditionally called
 * setProjectTrusted(true) after resolveProjectTrust() returned, so the final
 * pass loaded project resources even when trust was denied.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTrustSubject } from './subject.mjs';

const root = path.resolve(import.meta.dirname, '..');
// Re-create arrays in the host realm so deepStrictEqual does not trip over
// prototypes from the VM context that hosts the production module.
const basenames = (extensions) =>
	[...extensions].map((extension) => path.basename(extension.path, '.ts')).sort();

// ---------------------------------------------------------------------------
// 1. Denied trust: project resources stay out of both phases.
//    Starts from a previously trusted state to model a fresh reload whose
//    trust decision is later denied.
// ---------------------------------------------------------------------------
{
	const subject = await createTrustSubject(root, { initialTrusted: true });
	let bootstrapBasenames;
	let bootstrapTrustedSetting;
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapBasenames = basenames(extensionsResult.extensions);
			bootstrapTrustedSetting = subject.state.trusted;
			return false;
		},
	});

	assert.deepEqual(
		bootstrapBasenames,
		['cli', 'user'],
		'bootstrap phase must expose only user/global and CLI resources, never project resources',
	);
	assert.equal(bootstrapTrustedSetting, false, 'bootstrap phase must run with project trust disabled');

	const resolution = subject.events.filter((event) => event[0] === 'resolve');
	assert.equal(resolution.length, 2, 'reload should resolve resources once per phase');
	assert.equal(resolution[0][1], false, 'bootstrap resolve must happen with untrusted settings');
	assert.equal(
		resolution[1][1],
		false,
		'a denied trust decision must leave the final resolve untrusted instead of forcing approval',
	);

	const setEvents = subject.events.filter((event) => event[0] === 'set');
	assert.deepEqual(setEvents, [['set', false], ['set', false]], 'deny must keep the settings manager untrusted');

	const final = subject.loader.getExtensions();
	assert.deepEqual(
		basenames(final.extensions),
		['cli', 'user'],
		'after a denied decision, project resources must remain absent while user/global and CLI stay available',
	);
	assert.ok(
		![...final.extensions].some((extension) => path.basename(extension.path, '.ts') === 'project'),
		'denied project extension must not be loaded after reload',
	);
	assert.equal(subject.state.loadedTrust, false, 'final resource resolution must use the denied trust state');
}

// ---------------------------------------------------------------------------
// 2. Approved trust: project resources appear only after the decision.
// ---------------------------------------------------------------------------
{
	const subject = await createTrustSubject(root, { initialTrusted: false });
	let bootstrapBasenames;
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapBasenames = basenames(extensionsResult.extensions);
			return true;
		},
	});

	assert.deepEqual(
		bootstrapBasenames,
		['cli', 'user'],
		'bootstrap phase must never include project resources, even when they will be approved',
	);

	const resolution = subject.events.filter((event) => event[0] === 'resolve');
	assert.deepEqual(resolution, [
		['resolve', false],
		['resolve', true],
	], 'phase separation requires an untrusted bootstrap resolve followed by a trusted resolve');

	const final = subject.loader.getExtensions();
	assert.deepEqual(
		basenames(final.extensions),
		['cli', 'project', 'user'],
		'after an approved decision, user/global, CLI, and project resources must all be available',
	);
	assert.deepEqual(subject.events.filter((event) => event[0] === 'set'), [['set', false], ['set', true]]);
}

console.log('regression: denied trust no longer upgrades to approval; phase separation preserved');
