/**
 * Regression test for extension-trust/transfer.
 *
 * Loads the real `packages/coding-agent/src/core/resource-loader.ts` through the
 * boundary fakes in `.prale-eval/subject.mjs` and asserts the behaviors of a
 * trust-resolving `reload()`:
 *
 *  1. The bootstrap pass that feeds `resolveProjectTrust` keeps project-local
 *     extensions out (settings are forced untrusted while it runs).
 *  2. The explicit decision returned by `resolveProjectTrust` is honored — both
 *     `true` and `false` — instead of being replaced by a hardcoded value.
 *  3. Settings are reloaded for the decided trust state *before* the final
 *     resource resolution, so the final pass and final extension set see it.
 *
 * Exits 0 when the production code is repaired; throws an AssertionError on the
 * original fault, where the explicit decision is discarded.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { createTrustSubject } from './subject.mjs';

const root = process.cwd();

// Extension lists come back from a VM realm, so rebuild local arrays before comparing.
const localNames = (paths) => Array.from(paths, (path) => basename(path));
const copyEvents = (events) =>
	Array.from(events, (event) => Array.from(event, (value) => (Array.isArray(value) ? Array.from(value) : value)));
const eventsNamed = (events, name) => events.filter((event) => event[0] === name);
const show = (events) => JSON.stringify(events);

const checks = [];
function check(name, fn) {
	checks.push({ name, fn });
}

/** Run the real `reload()` with a scripted trust decision and capture what production code did. */
async function reloadWithDecision({ initialTrusted, decision }) {
	const subject = await createTrustSubject(root, { initialTrusted });
	const observed = { bootstrap: undefined, decisionAt: undefined };
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			const eventsBefore = copyEvents(subject.events);
			observed.bootstrap = {
				names: localNames(Array.from(extensionsResult.extensions, (extension) => extension.path)),
				resolveTrusts: eventsNamed(eventsBefore, 'resolve').map((event) => event[1]),
				loads: eventsNamed(eventsBefore, 'extensions').map((event) => event[1]),
			};
			observed.decisionAt = subject.events.length;
			return decision;
		},
	});
	observed.events = copyEvents(subject.events);
	observed.afterDecision = observed.events.slice(observed.decisionAt);
	observed.final = localNames(Array.from(subject.loader.getExtensions().extensions).map((ext) => ext.path));
	observed.state = { ...subject.state };
	return observed;
}

/** Index of the last event named `name`, plus its payload. */
function lastOf(events, name) {
	for (let index = events.length - 1; index >= 0; index--) {
		if (events[index][0] === name) return { index, event: events[index] };
	}
	return { index: -1, event: undefined };
}

check('bootstrap pass excludes project extensions while loading user and CLI ones', async () => {
	for (const initialTrusted of [true, false]) {
		const run = await reloadWithDecision({ initialTrusted, decision: true });
		assert.deepEqual(
			run.bootstrap.names,
			['cli.ts', 'user.ts'],
			`bootstrap must hand back CLI + user extensions only (initialTrusted=${initialTrusted}), got ${JSON.stringify(run.bootstrap.names)}`,
		);
		assert.deepEqual(
			run.bootstrap.loads.at(-1),
			['cli.ts', 'user.ts'],
			`bootstrap must not load project-local extensions (initialTrusted=${initialTrusted}), loaded ${JSON.stringify(run.bootstrap.loads)}`,
		);
		assert.ok(
			run.bootstrap.resolveTrusts.length > 0 && run.bootstrap.resolveTrusts.every((trusted) => trusted === false),
			`bootstrap must resolve resources with project trust forced off (initialTrusted=${initialTrusted}), saw ${JSON.stringify(run.bootstrap.resolveTrusts)}`,
		);
	}
});

check('explicit trusted decision is honored after bootstrap', async () => {
	const run = await reloadWithDecision({ initialTrusted: false, decision: true });

	assert.equal(run.state.trusted, true, 'resolveProjectTrust(true) must leave the project trusted');
	assert.deepEqual(
		run.final,
		['cli.ts', 'user.ts', 'project.ts'],
		`trusted decision must load the project extension into the final set, got ${JSON.stringify(run.final)}`,
	);
	assert.equal(
		run.final.filter((name) => name === 'project.ts').length,
		1,
		'project extension must be loaded exactly once',
	);
	assert.equal(
		run.final.filter((name) => name === 'user.ts').length,
		1,
		'the preloaded user extension must be reused, not duplicated',
	);
});

check('settings reload for the decided trust state precedes the final resolution', async () => {
	const run = await reloadWithDecision({ initialTrusted: false, decision: true });

	const settings = eventsNamed(run.afterDecision, 'settings');
	assert.ok(
		settings.length > 0,
		`settings must be reloaded again after the trust decision, events: ${show(run.afterDecision)}`,
	);
	assert.equal(
		settings.at(-1)[1],
		true,
		`the settings reload after the decision must use the decided trust state, events: ${show(run.afterDecision)}`,
	);

	const settingsIndex = run.afterDecision.indexOf(settings.at(-1));
	const resolve = lastOf(run.afterDecision, 'resolve');
	assert.notEqual(resolve.index, -1, 'final resource resolution must run after the trust decision');
	assert.ok(
		settingsIndex < resolve.index,
		`settings must be reloaded before the final resource resolution, events: ${show(run.afterDecision)}`,
	);
	assert.equal(
		resolve.event[1],
		true,
		`final resource resolution must observe the decided trust state, events: ${show(run.afterDecision)}`,
	);

	const finalLoad = lastOf(run.afterDecision, 'extensions');
	assert.ok(
		finalLoad.index > resolve.index,
		`the final extension load must follow the final resolution, events: ${show(run.afterDecision)}`,
	);
	assert.deepEqual(
		finalLoad.event[1],
		['project.ts'],
		`the final load pass must add only the newly trusted project extension, got ${JSON.stringify(finalLoad.event[1])}`,
	);
});

check('explicit untrusted decision keeps project extensions excluded', async () => {
	for (const initialTrusted of [true, false]) {
		const run = await reloadWithDecision({ initialTrusted, decision: false });

		assert.equal(run.state.trusted, false, 'resolveProjectTrust(false) must leave the project untrusted');
		assert.deepEqual(
			run.final,
			['cli.ts', 'user.ts'],
			`untrusted decision must not load the project extension (initialTrusted=${initialTrusted}), got ${JSON.stringify(run.final)}`,
		);
		const resolve = lastOf(run.afterDecision, 'resolve');
		assert.notEqual(resolve.index, -1, 'final resource resolution must run after the trust decision');
		assert.equal(
			resolve.event[1],
			false,
			`final resource resolution must observe the untrusted decision, events: ${show(run.afterDecision)}`,
		);
		const loads = eventsNamed(run.afterDecision, 'extensions');
		assert.ok(
			loads.every((event) => !event[1].includes('project.ts')),
			`no pass after an untrusted decision may load the project extension, loaded ${JSON.stringify(loads)}`,
		);
	}
});

check('a reload without a trust prompt keeps the existing trust state', async () => {
	const trusted = await createTrustSubject(root, { initialTrusted: true });
	await trusted.loader.reload();
	assert.deepEqual(
		localNames(Array.from(trusted.loader.getExtensions().extensions).map((ext) => ext.path)),
		['cli.ts', 'user.ts', 'project.ts'],
		'a reload without resolveProjectTrust must respect the already-trusted project',
	);

	const untrusted = await createTrustSubject(root, { initialTrusted: false });
	await untrusted.loader.reload();
	assert.deepEqual(
		localNames(Array.from(untrusted.loader.getExtensions().extensions).map((ext) => ext.path)),
		['cli.ts', 'user.ts'],
		'a reload without resolveProjectTrust must respect the already-untrusted project',
	);
});

for (const { name, fn } of checks) {
	try {
		await fn();
	} catch (error) {
		console.error(`FAILED: ${name}`);
		throw error;
	}
	console.log(`ok - ${name}`);
}
console.log(`all ${checks.length} trust-transfer checks passed`);
