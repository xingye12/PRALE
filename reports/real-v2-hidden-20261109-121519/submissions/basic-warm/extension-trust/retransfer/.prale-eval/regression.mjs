/**
 * Regression: a project trust decision must be transferred as-is on every reload.
 *
 * Phase separation required of DefaultResourceLoader.reload():
 *   - the bootstrap pass (loadProjectTrustExtensions) never exposes project resources;
 *   - a denied (false) decision keeps project resources out of the final set;
 *   - an approved (true) decision exposes project resources;
 *   - user/global and CLI extensions stay available in every phase.
 *
 * The original fault unconditionally called setProjectTrusted(true) after the
 * resolver returned, so a denied decision silently became approval.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BOOTSTRAP_ONLY = ["cli.ts", "user.ts"];
const DENIED = ["cli.ts", "user.ts"];
const APPROVED = ["cli.ts", "project.ts", "user.ts"];

function names(extensions) {
	// Copy into this realm: arrays created inside the VM context have a different
	// Array.prototype, which deepStrictEqual correctly treats as a mismatch.
	return Array.from(extensions, (extension) => path.basename(extension.path)).sort();
}

function resolveDecisions(events) {
	return events.filter(([kind]) => kind === "resolve").map(([, trusted]) => trusted);
}

function extensionLoads(events) {
	return events
		.filter(([kind]) => kind === "extensions")
		.map(([, loaded]) => loaded.slice().sort());
}

async function deniedThenApproved() {
	const { loader, events, state } = await createTrustSubject(root);
	let bootstrap = null;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrap = names(extensionsResult.extensions);
			return false;
		},
	});

	// Bootstrap happens before any trust decision and must not see project resources.
	assert.deepEqual(bootstrap, BOOTSTRAP_ONLY, "bootstrap must exclude project extensions while keeping user/CLI");
	// The denied decision must be the one applied to settings.
	assert.equal(state.trusted, false, "a denied decision must not mark the project trusted");
	assert.deepEqual(
		names(loader.getExtensions().extensions),
		DENIED,
		"after a denied decision only user/CLI extensions may remain loaded",
	);
	assert.equal(
		state.loadedTrust,
		false,
		"the final resource resolution must run with the denied trust state",
	);
	assert.deepEqual(resolveDecisions(events), [false, false], "every resolve must observe the denied trust state");
	assert.ok(
		!extensionLoads(events).some((loaded) => loaded.includes("project.ts")),
		"project extensions must never be loaded after a denied decision",
	);

	// A later reload with the same denied decision must stay denied.
	await loader.reload({ resolveProjectTrust: async () => false });
	assert.equal(state.trusted, false, "a repeated denied decision must not flip trust");
	assert.deepEqual(names(loader.getExtensions().extensions), DENIED, "repeated denied reload must stay project-free");

	// And an explicit approval on a fresh reload must make project resources available.
	await loader.reload({ resolveProjectTrust: async () => true });
	assert.equal(state.trusted, true, "an approved decision must mark the project trusted");
	assert.deepEqual(
		names(loader.getExtensions().extensions),
		APPROVED,
		"after approval project extensions must join user/CLI extensions",
	);
	assert.equal(state.loadedTrust, true, "the final resolution after approval must observe trusted settings");
}

async function approvedThenDenied() {
	const { loader, state } = await createTrustSubject(root);

	await loader.reload({ resolveProjectTrust: async () => true });
	assert.deepEqual(names(loader.getExtensions().extensions), APPROVED, "approval must load project resources");

	// A fresh reload with a denied decision must retract project resources.
	await loader.reload({ resolveProjectTrust: async () => false });
	assert.equal(state.trusted, false, "a fresh denied decision must revoke the earlier approval");
	assert.deepEqual(
		names(loader.getExtensions().extensions),
		DENIED,
		"a fresh denied decision must not leave project resources loaded",
	);
	assert.equal(state.loadedTrust, false, "a fresh denied decision must resolve resources as untrusted");
}

async function reloadWithoutResolverRespectsTrustState() {
	const trusted = await createTrustSubject(root, { initialTrusted: true });
	await trusted.loader.reload();
	assert.deepEqual(
		names(trusted.loader.getExtensions().extensions),
		APPROVED,
		"a reload without a resolver must keep an already trusted project available",
	);
	assert.equal(trusted.state.trusted, true, "a reload without a resolver must not change trust");

	const untrusted = await createTrustSubject(root, { initialTrusted: false });
	await untrusted.loader.reload();
	assert.deepEqual(
		names(untrusted.loader.getExtensions().extensions),
		DENIED,
		"a reload without a resolver must keep an untrusted project absent",
	);
	assert.equal(untrusted.state.trusted, false, "a reload without a resolver must not grant trust");
}

await deniedThenApproved();
await approvedThenDenied();
await reloadWithoutResolverRespectsTrustState();

console.log("regression: trust decisions preserved across resource reloads");
