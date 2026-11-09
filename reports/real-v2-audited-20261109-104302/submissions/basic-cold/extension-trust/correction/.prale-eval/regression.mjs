/**
 * Regression for extension-trust/correction.
 *
 * The loader must consult the reload-provided trust resolver exactly once, expose it
 * the untrusted bootstrap result, await its asynchronous decision, and then apply that
 * decision: project resources load after `true`, stay out after `false`.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTrustSubject } from './subject.mjs';

const root = path.resolve(import.meta.dirname, '..');
const RELOAD_TIMEOUT_MS = 20_000;
// Spread into a host-realm array: the loader's arrays come from another VM context.
const names = (extensionsResult) => [...extensionsResult.extensions].map((extension) => path.basename(extension.path)).sort();

/** Runs one reload against the real DefaultResourceLoader and records boundary events. */
async function reloadWithTrustDecision(decision) {
	const { loader, events, state } = await createTrustSubject(root);
	const observations = [];

	const record = (label, extensionsResult) => {
		observations.push({
			label,
			trusted: state.trusted,
			loadedTrust: state.loadedTrust,
			extensions: names(extensionsResult),
		});
		events.push([label]);
	};

	let calls = 0;
	const reload = loader.reload({
		async resolveProjectTrust({ extensionsResult }) {
			calls += 1;
			record('resolver-enter', extensionsResult);
			// Suspends the reload: the loader must wait for this promise to settle.
			await new Promise((resolve) => setTimeout(resolve, 10));
			record('resolver-exit', extensionsResult);
			return decision;
		},
	});

	// Safety net so a deadlocked loader fails instead of hanging the validation run.
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`reload did not settle within ${RELOAD_TIMEOUT_MS}ms`)), RELOAD_TIMEOUT_MS);
	});
	try {
		await Promise.race([reload, timeout]);
	} finally {
		clearTimeout(timer);
	}

	return { loader, events, state, observations, calls };
}

/** Index of the first event matching `name` at or after `from`. */
function indexOf(events, name, from = 0) {
	return events.findIndex((event, index) => index >= from && event[0] === name);
}

async function checkTrustedDecisionAllowsProjectResources() {
	const { loader, events, state, observations, calls } = await reloadWithTrustDecision(true);

	assert.equal(calls, 1, 'the reload must call the trust resolver exactly once');

	// The resolver observes the untrusted bootstrap load: user/CLI resources only.
	const [bootstrap] = observations;
	assert.equal(bootstrap.label, 'resolver-enter', 'the resolver must run during reload');
	assert.equal(bootstrap.trusted, false, 'the resolver must observe an untrusted project trust state');
	assert.deepEqual(bootstrap.extensions, ['cli.ts', 'user.ts'], 'the resolver must observe the untrusted bootstrap result');

	// The bootstrap load happens before the resolver runs.
	const bootstrapLoad = indexOf(events, 'extensions');
	const resolverEnter = indexOf(events, 'resolver-enter');
	assert.ok(bootstrapLoad >= 0, 'the untrusted bootstrap extensions must be loaded before resolving trust');
	assert.ok(bootstrapLoad < resolverEnter, 'the bootstrap extensions must load before the resolver is consulted');

	// Asynchronous ordering: nothing is decided or reloaded while the resolver is pending.
	const resolverExit = indexOf(events, 'resolver-exit');
	assert.ok(resolverExit > resolverEnter, 'the reload must await the resolver promise');
	assert.deepEqual(
		events.slice(resolverEnter + 1, resolverExit),
		[],
		'the loader must not apply a decision while the async resolver is still pending',
	);

	// A `true` decision is applied: project settings get reloaded as trusted and
	// project resources are resolved afterwards.
	const appliedTrust = indexOf(events, 'set', resolverExit);
	assert.ok(appliedTrust >= 0, 'the resolver decision must be applied to project trust settings');
	assert.deepEqual(events[appliedTrust], ['set', true], 'a true decision must be propagated to the settings manager');
	const resolvedTrusted = indexOf(events, 'resolve', appliedTrust);
	assert.ok(resolvedTrusted >= 0, 'project resources must be resolved after the trust decision');
	assert.deepEqual(events[resolvedTrusted], ['resolve', true], 'project resources must be resolved with the trusted decision');

	const finalNames = names(loader.getExtensions());
	assert.deepEqual(finalNames, ['cli.ts', 'project.ts', 'user.ts'], 'project resources must load after a true decision');
	assert.equal(
		events.flatMap((event) => (event[0] === 'extensions' ? event[1] : [])).filter((name) => name === 'user.ts').length,
		1,
		'user extensions must be reused from the untrusted bootstrap instead of being loaded twice',
	);
	assert.equal(state.trusted, true, 'the loader must leave the settings manager in the resolved trust state');
}

async function checkFalseDecisionDeniesProjectResources() {
	const { loader, events, state, observations, calls } = await reloadWithTrustDecision(false);

	assert.equal(calls, 1, 'the reload must call the trust resolver exactly once');
	const [bootstrap] = observations;
	assert.deepEqual(bootstrap.extensions, ['cli.ts', 'user.ts'], 'the resolver must observe the untrusted bootstrap result');
	assert.equal(bootstrap.trusted, false, 'the resolver must observe an untrusted project trust state');

	const resolverExit = indexOf(events, 'resolver-exit');
	assert.ok(resolverExit > 0, 'the reload must await the resolver promise');
	assert.deepEqual(
		events.slice(indexOf(events, 'resolver-enter') + 1, resolverExit),
		[],
		'the loader must not apply a decision while the async resolver is still pending',
	);

	const finalNames = names(loader.getExtensions());
	assert.deepEqual(finalNames, ['cli.ts', 'user.ts'], 'project resources must stay out after a false decision');
	assert.ok(
		!events.slice(resolverExit).some((event) => event[0] === 'resolve' && event[1] === true),
		'project resources must never be resolved as trusted after a false decision',
	);
	assert.equal(state.trusted, false, 'the loader must leave the settings manager in the resolved trust state');
}

await checkTrustedDecisionAllowsProjectResources();
await checkFalseDecisionDeniesProjectResources();
console.log('extension-trust regression: trust resolver consulted once and its decision applied asynchronously');
