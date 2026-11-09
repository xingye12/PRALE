/**
 * Regression for extension-trust/transfer.
 *
 * Exercises the real DefaultResourceLoader.reload() lifecycle through the
 * boundary fakes exported by subject.mjs. The incident: after the untrusted
 * bootstrap pass, reload() discarded the explicit project-trust decision and
 * forced the project back to untrusted, so trusted project extensions were
 * never resolved while an already-trusted project could also leak into the
 * bootstrap pass.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrustSubject } from './subject.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = (extensions) => Array.from(extensions, (extension) => path.basename(extension.path));

function resolveEvents(events) {
	return events.filter((event) => event[0] === 'resolve');
}

function extensionEvents(events) {
	return events.filter((event) => event[0] === 'extensions');
}

function indexOfEvent(events, event) {
	const index = events.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(event));
	assert.notEqual(index, -1, `expected event ${JSON.stringify(event)} in ${JSON.stringify(events)}`);
	return index;
}

/**
 * Runs one explicit trust decision and returns the observable lifecycle.
 * `initialTrusted` models the persisted trust state before the bootstrap pass.
 */
async function runDecision(decision, initialTrusted) {
	const subject = await createTrustSubject(root, { initialTrusted });
	let sawBootstrapExtensions;
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			sawBootstrapExtensions = extensionsResult;
			return decision;
		},
	});
	return {
		...subject,
		sawBootstrapExtensions,
		extensions: names(subject.loader.getExtensions().extensions),
	};
}

// ---------------------------------------------------------------------------
// Explicit true decision: bootstrap must stay untrusted, then the decision
// must be transferred to the settings manager and used for final resolution.
// ---------------------------------------------------------------------------
{
	const { events, state, sawBootstrapExtensions, extensions } = await runDecision(true, true);
	const bootstrapNames = names(sawBootstrapExtensions.extensions);

	// The bootstrap pass must not include project extensions, even though the
	// persisted state before reload was trusted.
	assert.deepEqual(
		bootstrapNames,
		['cli.ts', 'user.ts'],
		`bootstrap must exclude project extensions, got ${JSON.stringify(bootstrapNames)}`,
	);
	const bootstrapResolve = resolveEvents(events)[0];
	assert.deepEqual(
		bootstrapResolve,
		['resolve', false],
		`bootstrap package resolution must run untrusted, got ${JSON.stringify(bootstrapResolve)}`,
	);

	// The explicit decision must be installed on the settings manager, and the
	// settings must be reloaded for that trust state before final resolution.
	assert.equal(
		state.trusted,
		true,
		`explicit true decision was ignored; settings trust is ${JSON.stringify(state.trusted)}`,
	);
	const transferred = indexOfEvent(events, ['set', true]);
	const settingsReload = indexOfEvent(events, ['settings', true]);
	const finalResolve = indexOfEvent(events, ['resolve', true]);
	assert.ok(
		transferred < settingsReload,
		`settings must be reloaded after applying the decision: ${JSON.stringify(events)}`,
	);
	assert.ok(
		settingsReload < finalResolve,
		`settings must be reloaded before final resource resolution: ${JSON.stringify(events)}`,
	);

	// Trusted project extensions are resolved and loaded exactly once, reusing
	// the bootstrap-preloaded user/CLI extensions.
	assert.deepEqual(
		extensions,
		['cli.ts', 'user.ts', 'project.ts'],
		`trusted project extensions must load after an explicit true decision, got ${JSON.stringify(extensions)}`,
	);
	const projectLoadIndex = events.findIndex(
		(event) => event[0] === 'extensions' && event[1].includes('project.ts'),
	);
	assert.notEqual(projectLoadIndex, -1, 'project extension was never loaded');
	assert.ok(
		projectLoadIndex > transferred,
		'project extensions must not be loaded during the untrusted bootstrap pass',
	);
	assert.equal(
		extensionEvents(events).filter(([, loaded]) => loaded.includes('project.ts')).length,
		1,
		`project extension must be loaded by exactly one pass, got ${JSON.stringify(events)}`,
	);
	assert.equal(
		extensions.filter((name) => name === 'project.ts').length,
		1,
		`project extension must be loaded exactly once, got ${JSON.stringify(extensions)}`,
	);
}

// ---------------------------------------------------------------------------
// Explicit false decision: it is honored too. Project extensions stay out and
// user/CLI extensions survive the second settings reload.
// ---------------------------------------------------------------------------
{
	const { events, state, sawBootstrapExtensions, extensions } = await runDecision(false, true);
	const bootstrapNames = names(sawBootstrapExtensions.extensions);

	assert.deepEqual(
		bootstrapNames,
		['cli.ts', 'user.ts'],
		`bootstrap must exclude project extensions, got ${JSON.stringify(bootstrapNames)}`,
	);
	assert.equal(
		state.trusted,
		false,
		`explicit false decision must be honored; settings trust is ${JSON.stringify(state.trusted)}`,
	);
	const finalResolve = resolveEvents(events).at(-1);
	assert.deepEqual(
		finalResolve,
		['resolve', false],
		`final package resolution must reflect the false decision, got ${JSON.stringify(finalResolve)}`,
	);
	assert.deepEqual(
		extensions,
		['cli.ts', 'user.ts'],
		`untrusted project extensions must stay excluded, got ${JSON.stringify(extensions)}`,
	);
	assert.ok(!extensions.includes('project.ts'), 'project extension leaked into an untrusted reload');
}

// A false decision from an already-untrusted persisted state must also work.
{
	const { state, extensions } = await runDecision(false, false);
	assert.equal(state.trusted, false);
	assert.deepEqual(extensions, ['cli.ts', 'user.ts']);
}

console.log('extension-trust/transfer regression passed');
