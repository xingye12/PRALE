/**
 * Regression for extension-trust/transfer.
 *
 * Exercises the real DefaultResourceLoader.reload() lifecycle (resource-loader.ts)
 * through .prale-eval/subject.mjs, with settings/package/extension boundary fakes
 * that record the order of trust updates, settings reloads and resource resolution.
 *
 * Original fault: after the bootstrap (untrusted) pass, reload() forced
 * `setProjectTrusted(false)` even when the explicit trust decision was `true`, so
 * the trusted decision was ignored, settings were reloaded for the wrong state and
 * project extensions never made it into the final extension set.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrustSubject } from './subject.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Arrays returned across the VM realm boundary have a foreign Array.prototype, so copy
// them into local arrays before strict comparison.
const basenames = (extensions) => Array.from(extensions, (extension) => path.basename(extension.path));

const resolveTrustValues = (events) =>
	events.filter((event) => event[0] === 'resolve').map((event) => event[1]);

const lastResolveIndex = (events) => {
	for (let index = events.length - 1; index >= 0; index--) {
		if (events[index][0] === 'resolve') return index;
	}
	return -1;
};

async function runDecision(initialTrusted, decision) {
	const { loader, events } = await createTrustSubject(root, { initialTrusted });
	let preTrustExtensionNames;
	const resolveProjectTrust = async ({ extensionsResult }) => {
		preTrustExtensionNames = basenames(extensionsResult.extensions);
		return decision;
	};

	await loader.reload({ resolveProjectTrust });

	const finalTrust = loader.getExtensions();
	const finalResolve = events[lastResolveIndex(events)];
	let reloadBeforeFinalResolve = false;
	for (let index = 0; index < lastResolveIndex(events); index++) {
		if (events[index][0] === 'settings' && events[index][1] === decision) {
			reloadBeforeFinalResolve = true;
		}
	}
	return {
		events,
		preTrustExtensionNames,
		finalExtensionNames: basenames(finalTrust.extensions),
		finalResolveTrust: finalResolve?.[1],
		reloadBeforeFinalResolve,
		resolveTrustValues: resolveTrustValues(events),
		errors: Array.from(finalTrust.errors),
	};
}

for (const initialTrusted of [true, false]) {
	// --- Explicit `true` decision must be honored end to end. ---
	const trusted = await runDecision(initialTrusted, true);

	// Bootstrap pass must stay project-untrusted: resolve() sees trust=false and the
	// extension result handed to the trust resolver contains no project extension.
	assert.deepEqual(
		trusted.resolveTrustValues,
		[false, true],
		`[initialTrusted=${initialTrusted}] resource resolution must run untrusted for bootstrap and then with the explicit true decision; got ${JSON.stringify(trusted.resolveTrustValues)}`,
	);
	assert.equal(
		trusted.finalResolveTrust,
		true,
		`[initialTrusted=${initialTrusted}] final resource resolution must observe the trusted decision; got ${trusted.finalResolveTrust}`,
	);
	assert.equal(
		trusted.reloadBeforeFinalResolve,
		true,
		`[initialTrusted=${initialTrusted}] settings must be reloaded for the trusted decision before final resource resolution; events=${JSON.stringify(trusted.events)}`,
	);
	assert.ok(
		!trusted.preTrustExtensionNames.includes('project.ts'),
		`[initialTrusted=${initialTrusted}] project extensions must stay excluded during bootstrap; got ${JSON.stringify(trusted.preTrustExtensionNames)}`,
	);
	assert.deepEqual(
		trusted.preTrustExtensionNames.slice().sort(),
		['cli.ts', 'user.ts'],
		`[initialTrusted=${initialTrusted}] bootstrap must load only user/global and CLI extensions`,
	);
	assert.deepEqual(
		trusted.finalExtensionNames.slice().sort(),
		['cli.ts', 'project.ts', 'user.ts'],
		`[initialTrusted=${initialTrusted}] an explicit trusted decision must include project extensions in the final set; got ${JSON.stringify(trusted.finalExtensionNames)}`,
	);
	assert.deepEqual(
		trusted.errors,
		[],
		`[initialTrusted=${initialTrusted}] trusted reload must not report errors: ${JSON.stringify(trusted.errors)}`,
	);

	// --- Explicit `false` decision must be honored too (no trusted leakage). ---
	const untrusted = await runDecision(initialTrusted, false);
	assert.deepEqual(
		untrusted.resolveTrustValues,
		[false, false],
		`[initialTrusted=${initialTrusted}] bootstrap and final resolution must both be untrusted for a false decision; got ${JSON.stringify(untrusted.resolveTrustValues)}`,
	);
	assert.equal(
		untrusted.finalResolveTrust,
		false,
		`[initialTrusted=${initialTrusted}] final resource resolution must observe the false decision`,
	);
	assert.ok(
		!untrusted.preTrustExtensionNames.includes('project.ts'),
		`[initialTrusted=${initialTrusted}] project extensions must stay excluded during bootstrap; got ${JSON.stringify(untrusted.preTrustExtensionNames)}`,
	);
	assert.deepEqual(
		untrusted.finalExtensionNames.slice().sort(),
		['cli.ts', 'user.ts'],
		`[initialTrusted=${initialTrusted}] an explicit untrusted decision must exclude project extensions from the final set; got ${JSON.stringify(untrusted.finalExtensionNames)}`,
	);
	assert.deepEqual(
		untrusted.errors,
		[],
		`[initialTrusted=${initialTrusted}] untrusted reload must not report errors: ${JSON.stringify(untrusted.errors)}`,
	);
}

console.log('extension-trust/transfer regression: trust decisions, bootstrap exclusion and reload ordering verified');
