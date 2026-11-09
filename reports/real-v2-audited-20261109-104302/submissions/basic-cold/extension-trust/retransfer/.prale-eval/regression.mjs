/**
 * Regression: a denied project-trust decision must survive reload.
 *
 * The loader performs a bootstrap pass with trust forced off, asks the caller to
 * resolve trust, and then reloads with the resolved state. If the resolved
 * decision is discarded (denial treated as approval), project-scoped extensions
 * appear after a denial. Bootstrap must always exclude project resources, user and
 * CLI resources must always be present, and project resources may appear only
 * after an explicit `true` decision.
 */
import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Array.from keeps the result in this realm so deep equality compares like with like
// (the subject runs in a vm context with its own Array prototype).
const names = (result) =>
	Array.from(result.extensions, (extension) => basename(extension.path, ".ts")).sort();

// --- A denial keeps project resources out, in the bootstrap pass and after reload ---
{
	const subject = await createTrustSubject(root, { initialTrusted: true });
	let bootstrapNames;
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = names(extensionsResult);
			return false;
		},
	});

	assert.deepEqual(
		bootstrapNames,
		["cli", "user"],
		"bootstrap pass must exclude project extensions while keeping user and CLI extensions",
	);
	assert.deepEqual(
		names(subject.loader.getExtensions()),
		["cli", "user"],
		"a denied trust decision must not load project extensions (denial treated as approval)",
	);
	assert.equal(subject.state.trusted, false, "denied decision must stay untrusted in settings");
	assert.equal(subject.state.loadedTrust, false, "settings must be reloaded as untrusted after denial");

	// A subsequent fresh reload must not promote the denied decision to approval.
	await subject.loader.reload();
	assert.deepEqual(
		names(subject.loader.getExtensions()),
		["cli", "user"],
		"a fresh reload after denial must keep project extensions absent",
	);
}

// --- Approval loads project resources, still after a project-free bootstrap ---
{
	const subject = await createTrustSubject(root, { initialTrusted: true });
	let bootstrapNames;
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = names(extensionsResult);
			return true;
		},
	});

	assert.deepEqual(
		bootstrapNames,
		["cli", "user"],
		"bootstrap pass must exclude project extensions even when trust is later granted",
	);
	assert.deepEqual(
		names(subject.loader.getExtensions()),
		["cli", "project", "user"],
		"an approved trust decision must load project extensions alongside user and CLI extensions",
	);
	assert.equal(subject.state.trusted, true, "approved decision must be trusted in settings");
	assert.equal(subject.state.loadedTrust, true, "settings must be reloaded as trusted after approval");
}

// --- The resolved decision is re-evaluated on each reload, not sticky ---
{
	const subject = await createTrustSubject(root, { initialTrusted: true });
	await subject.loader.reload({ resolveProjectTrust: async () => false });
	assert.deepEqual(
		names(subject.loader.getExtensions()),
		["cli", "user"],
		"first reload denied trust, so project extensions must be absent",
	);

	await subject.loader.reload({ resolveProjectTrust: async () => true });
	assert.deepEqual(
		names(subject.loader.getExtensions()),
		["cli", "project", "user"],
		"second reload approved trust, so project extensions must be present",
	);
}

console.log("extension-trust/retransfer regression: passed");
