/**
 * Regression for extension-trust/correction.
 *
 * Fault (original): DefaultResourceLoader.reload() hard-coded `projectTrusted = false`
 * under `options.resolveProjectTrust`, so the trust resolver was never consulted and
 * project resources were denied even after a `true` decision.
 *
 * Repaired behavior asserted here:
 *  - the resolver callback runs exactly once, after the untrusted bootstrap load
 *    (it observes only user + CLI extensions, never project ones);
 *  - a `true` decision re-enables project resources for the final load;
 *  - a `false` decision keeps project resources out;
 *  - the asynchronous ordering is preserved: bootstrap -> resolver -> trust applied
 *    -> settings reload -> final resolution.
 *
 * Run from the workspace root: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTrustSubject } from './subject.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function names(extensions) {
	// Array.from (host realm) keeps the result a host array: the subject runs inside a VM context,
	// so VM-realm arrays would fail deepStrictEqual's prototype check for an unrelated reason.
	return Array.from(extensions, (extension) => String(extension.path).split(/[\\/]/).pop()).sort();
}

// The events array from the subject is caller-owned; tagging resolver calls with it lets us
// assert the relative ordering of the whole reload lifecycle.
function instrumentedResolver(events, decision) {
	const observations = [];
	const resolve = async ({ extensionsResult }) => {
		assert.ok(extensionsResult, 'resolver must receive the bootstrap extensions result');
		observations.push(names(extensionsResult.extensions));
		events.push(['resolver', decision]);
		// Resolve asynchronously so a non-awaited call would be observable as "false".
		await Promise.resolve();
		return decision;
	};
	return { resolve, observations };
}

function indexOf(events, predicate, description) {
	const index = events.findIndex(predicate);
	assert.ok(index !== -1, `expected reload events to contain ${description}; got ${JSON.stringify(events)}`);
	return index;
}

// --- Case 1: a true decision allows project resources, resolver runs once after bootstrap. ---
{
	const { loader, events } = await createTrustSubject(root);
	const { resolve, observations } = instrumentedResolver(events, true);

	await loader.reload({ resolveProjectTrust: resolve });

	assert.equal(observations.length, 1, 'trust resolver must be called exactly once');
	assert.deepEqual(
		observations[0],
		['cli.ts', 'user.ts'],
		'the resolver must observe only the untrusted bootstrap extensions (no project resources)',
	);

	assert.deepEqual(
		names(loader.getExtensions().extensions),
		['cli.ts', 'project.ts', 'user.ts'],
		'a true trust decision must allow project resources in the final extension set',
	);

	const bootstrapSet = indexOf(events, (e) => e[0] === 'set' && e[1] === false, 'the untrusted bootstrap switch');
	const resolverCall = indexOf(events, (e) => e[0] === 'resolver', 'the resolver invocation');
	const trustedSet = indexOf(events, (e) => e[0] === 'set' && e[1] === true, 'the trusted switch');
	const trustedResolve = indexOf(
		events,
		(e) => e[0] === 'resolve' && e[1] === true,
		'a final resolution against trusted settings',
	);

	assert.ok(bootstrapSet < resolverCall, 'the bootstrap load must complete before the resolver runs');
	assert.ok(resolverCall < trustedSet, 'the resolved decision must be applied after the resolver returns');
	assert.ok(trustedSet < trustedResolve, 'trust must be applied before project resources are resolved');
}

// --- Case 2: a false decision denies project resources and is still awaited. ---
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	const { resolve, observations } = instrumentedResolver(events, false);

	await loader.reload({ resolveProjectTrust: resolve });

	assert.equal(observations.length, 1, 'trust resolver must be called exactly once for a denial too');
	assert.deepEqual(
		observations[0],
		['cli.ts', 'user.ts'],
		'the resolver must observe only the untrusted bootstrap extensions (no project resources)',
	);
	assert.deepEqual(
		names(loader.getExtensions().extensions),
		['cli.ts', 'user.ts'],
		'a false trust decision must deny project resources in the final extension set',
	);
	assert.equal(state.trusted, false, 'a false decision must be applied to the settings manager');

	const resolverCall = indexOf(events, (e) => e[0] === 'resolver', 'the resolver invocation');
	// Two untrusted switches exist (bootstrap pass and the post-decision one); the last is the decision.
	const deniedSet = events.findLastIndex((e) => e[0] === 'set' && e[1] === false);
	assert.ok(events.filter((e) => e[0] === 'set').length >= 2, 'both the bootstrap and the decision must set trust');
	assert.ok(resolverCall < deniedSet, 'the awaited denial must be applied after the resolver returns');
}

// --- Case 3: no resolver means no bootstrap pass and trusted settings stay untouched. ---
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload();

	assert.equal(
		events.filter((e) => e[0] === 'set').length,
		0,
		'reload() without a resolver must not force any trust state',
	);
	assert.equal(state.trusted, true, 'settings trust must be preserved when no resolver is supplied');
	assert.deepEqual(
		names(loader.getExtensions().extensions),
		['cli.ts', 'project.ts', 'user.ts'],
		'a plain reload must keep the already-trusted project resources',
	);
}

console.log('extension-trust/correction regression: passed');
