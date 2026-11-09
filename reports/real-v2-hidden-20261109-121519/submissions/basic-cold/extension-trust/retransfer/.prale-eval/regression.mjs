/**
 * Regression for extension-trust/retransfer.
 *
 * A resource reload must preserve the trust decision it was given:
 *  - bootstrap pass: project resources absent, user/global and CLI present;
 *  - decision false: project resources stay absent after reload;
 *  - decision true: project resources become available after reload.
 *
 * The original fault applied `setProjectTrusted(true)` unconditionally after
 * `resolveProjectTrust`, so a denied decision was upgraded to approval and the
 * project extension reappeared on the reload.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stem = (extension) => path.basename(extension.path).replace(/\.[^.]+$/, "");
// Array.from keeps the result in this realm; VM-realm arrays fail strict deep equality.
const names = (extensions) => Array.from(extensions, stem).sort();

function extensionNames(loader) {
	return names(loader.getExtensions().extensions);
}

async function reloadWithDecision(decision, options = {}) {
	const subject = await createTrustSubject(root, options);
	let bootstrapExtensions;
	let bootstrapTrust;
	await subject.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapExtensions = extensionsResult.extensions;
			bootstrapTrust = subject.state.trusted;
			return decision;
		},
	});
	return { ...subject, bootstrapExtensions, bootstrapTrust };
}

// --- Denied decision: project resources must not be transferred into approval.
{
	const { loader, state, bootstrapExtensions, bootstrapTrust } = await reloadWithDecision(false, {
		initialTrusted: true,
	});

	assert.deepEqual(
		names(bootstrapExtensions),
		["cli", "user"],
		"bootstrap pass must load user/global and CLI extensions but not project extensions",
	);
	assert.equal(bootstrapTrust, false, "bootstrap pass must run with project trust disabled");

	assert.deepEqual(
		extensionNames(loader),
		["cli", "user"],
		"denied project trust must not load project resources after reload",
	);
	assert.equal(state.trusted, false, "denied project trust must leave the loader/settings untrusted");
	assert.equal(
		state.loadedTrust,
		false,
		"settings reload after a denied decision must observe the denied trust state",
	);
}

// --- Approved decision: project resources become available after reload.
{
	const { loader, state, bootstrapExtensions, bootstrapTrust } = await reloadWithDecision(true, {
		initialTrusted: false,
	});

	assert.deepEqual(
		names(bootstrapExtensions),
		["cli", "user"],
		"bootstrap pass must load user/global and CLI extensions but not project extensions",
	);
	assert.equal(bootstrapTrust, false, "bootstrap pass must run with project trust disabled");

	assert.deepEqual(
		extensionNames(loader),
		["cli", "project", "user"],
		"approved project trust must load project resources plus user/global and CLI resources",
	);
	assert.equal(state.trusted, true, "approved project trust must be recorded on the settings manager");
	assert.equal(state.loadedTrust, true, "settings reload after approval must observe the approved trust state");
}

// --- A later reload without a new decision keeps the denied state.
{
	const first = await reloadWithDecision(false);
	await first.loader.reload();
	assert.deepEqual(
		extensionNames(first.loader),
		["cli", "user"],
		"a follow-up reload without a trust decision must not revive project resources after denial",
	);
	assert.equal(first.state.trusted, false, "a follow-up reload must preserve the denied trust state");
}

console.log("extension-trust/retransfer regression passed");
