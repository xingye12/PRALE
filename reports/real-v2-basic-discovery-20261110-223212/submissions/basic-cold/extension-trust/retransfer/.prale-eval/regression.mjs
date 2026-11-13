/**
 * Regression: a denied project-trust decision must not be re-transferred into an
 * approval on a fresh resource reload.
 *
 * Phase separation contract:
 *  - bootstrap pass loads user/global and CLI resources only (project absent);
 *  - after `resolveProjectTrust` returns false, project resources stay absent;
 *  - after it returns true, project resources are available;
 *  - user/global and CLI resources remain available in every phase.
 *
 * Exits 0 when the repaired loader preserves that contract and throws an
 * assertion (non-zero exit) on the original fault, where a `false` decision was
 * overwritten by `setProjectTrusted(true)`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTrustSubject } from './subject.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** Extension basenames loaded by the real DefaultResourceLoader after a reload. */
function loadedExtensionNames(loader) {
	const result = loader.getExtensions();
	assert.ok(result, 'loader must expose an extension result');
	assert.ok(Array.isArray(result.extensions), 'extension result must contain an extensions array');
	// Array.from keeps the array in this realm so strict deep-equal compares values only.
	const names = Array.from(result.extensions, (extension) => path.basename(extension.path, '.ts'));
	return names.sort();
}

function assertSameSet(actual, expected, message) {
	assert.deepEqual(
		actual,
		[...expected].sort(),
		`${message}: expected [${[...expected].sort().join(', ')}], got [${actual.join(', ')}]`,
	);
}

// 1. Bootstrap phase separation: project resources are absent while the trust
//    decision is being resolved, user/global and CLI are already available.
{
	const { loader } = await createTrustSubject(root, { initialTrusted: true });
	let bootstrapNames;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = Array.from(extensionsResult.extensions, (extension) =>
				path.basename(extension.path, '.ts'),
			).sort();
			return false;
		},
	});
	assertSameSet(bootstrapNames, ['cli', 'user'], 'bootstrap pass must not load project resources');
}

// 2. Denied decision: project resources stay absent after the reload completes,
//    user/global and CLI remain available.
{
	const { loader, state } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload({ resolveProjectTrust: async () => false });

	const names = loadedExtensionNames(loader);
	assert.ok(
		!names.includes('project'),
		`denied trust must keep project resources absent, got [${names.join(', ')}]`,
	);
	assertSameSet(names, ['cli', 'user'], 'denied trust must still load user/global and CLI resources');
	assert.equal(state.trusted, false, 'denied trust decision must be persisted as untrusted');
}

// 3. Approved decision: project resources are available after the reload,
//    together with user/global and CLI resources.
{
	const { loader, state } = await createTrustSubject(root, { initialTrusted: false });
	await loader.reload({ resolveProjectTrust: async () => true });

	assertSameSet(loadedExtensionNames(loader), ['cli', 'project', 'user'], 'approved trust must load project resources');
	assert.equal(state.trusted, true, 'approved trust decision must be persisted as trusted');
}

// 4. A fresh reload after a denial must not re-transfer the denial into approval:
//    the project trust state survives and project resources stay absent.
{
	const { loader, state } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload({ resolveProjectTrust: async () => true });
	assertSameSet(loadedExtensionNames(loader), ['cli', 'project', 'user'], 'approved trust must load project resources');

	await loader.reload({ resolveProjectTrust: async () => false });
	let names = loadedExtensionNames(loader);
	assert.ok(!names.includes('project'), `fresh denied reload must not load project resources, got [${names.join(', ')}]`);
	assertSameSet(names, ['cli', 'user'], 'fresh denied reload must keep user/global and CLI resources');
	assert.equal(state.trusted, false, 'fresh denied reload must persist the denial');

	// Plain reload without a trust callback preserves the denied state.
	await loader.reload();
	names = loadedExtensionNames(loader);
	assert.ok(!names.includes('project'), `reload after denial must not load project resources, got [${names.join(', ')}]`);
	assertSameSet(names, ['cli', 'user'], 'reload after denial must keep user/global and CLI resources');
}
