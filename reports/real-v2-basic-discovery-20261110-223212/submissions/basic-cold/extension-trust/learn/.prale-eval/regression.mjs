/**
 * Regression: project extensions must never leak into the trust bootstrap pass.
 *
 * The bootstrap (`ResourceLoader.loadProjectTrustExtensions`, invoked by
 * `reload({ resolveProjectTrust })`) must force *untrusted* project settings
 * before it reloads settings and resolves extension sources, even when the
 * settings manager still remembers a trusted previous state. User/global and
 * temporary CLI extensions must remain available during that pass so trust can
 * be decided with full context.
 */
import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

// Load the production sources that sit next to this test, not whatever cwd holds.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = (result) => result.extensions.map((extension) => basename(extension.path));

const indexOfEvent = (events, predicate) => events.findIndex(predicate);
const sawSet = (events, value) => indexOfEvent(events, (e) => e[0] === "set" && e[1] === value);
const sawSettings = (events, value) => indexOfEvent(events, (e) => e[0] === "settings" && e[1] === value);
const firstResolve = (events) => indexOfEvent(events, (e) => e[0] === "resolve");

// --- 1. reload() with a trusted previous state must still bootstrap untrusted.
{
	const { loader, events } = await createTrustSubject(root, { initialTrusted: true });
	let preTrust;
	let preTrustDuringResolve;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			preTrust = extensionsResult;
			preTrustDuringResolve = events.findLast((e) => e[0] === "resolve");
			return true;
		},
	});

	assert.ok(preTrust, "resolveProjectTrust must receive the bootstrap extensions result");

	const bootstrapNames = names(preTrust);
	assert.ok(
		!bootstrapNames.includes("project.ts"),
		`project extensions must not load during the trust bootstrap, got ${JSON.stringify(bootstrapNames)}`,
	);
	assert.ok(
		bootstrapNames.includes("user.ts"),
		`user/global extensions must remain available during the trust bootstrap, got ${JSON.stringify(bootstrapNames)}`,
	);
	assert.ok(
		bootstrapNames.includes("cli.ts"),
		`temporary CLI extensions must remain available during the trust bootstrap, got ${JSON.stringify(bootstrapNames)}`,
	);

	// Settings were forced untrusted before the bootstrap resolve ran.
	const setUntrusted = sawSet(events, false);
	const settingsUntrusted = sawSettings(events, false);
	const resolveIndex = firstResolve(events);
	assert.notEqual(setUntrusted, -1, `settings must be forced untrusted, events: ${JSON.stringify(events)}`);
	assert.notEqual(settingsUntrusted, -1, `untrusted settings must be reloaded, events: ${JSON.stringify(events)}`);
	assert.notEqual(resolveIndex, -1, `the bootstrap must resolve extensions, events: ${JSON.stringify(events)}`);
	assert.ok(
		setUntrusted < settingsUntrusted && settingsUntrusted < resolveIndex,
		`untrusted settings must be applied and reloaded before extensions resolve, events: ${JSON.stringify(events)}`,
	);
	assert.deepEqual(
		preTrustDuringResolve,
		["resolve", false],
		`the bootstrap extension resolve must observe untrusted settings, events: ${JSON.stringify(events)}`,
	);

	// The trusted reload that follows the trust decision still gets project extensions.
	const finalNames = names(loader.getExtensions());
	for (const expected of ["user.ts", "project.ts", "cli.ts"]) {
		assert.ok(finalNames.includes(expected), `trusted reload must include ${expected}, got ${JSON.stringify(finalNames)}`);
	}
}

// --- 2. A second bootstrap (previous state trusted) must be untrusted again.
{
	const { loader, events } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload({ resolveProjectTrust: async () => true });
	const firstReloadCount = events.length;

	let secondPreTrust;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			secondPreTrust = extensionsResult;
			return true;
		},
	});
	const secondEvents = events.slice(firstReloadCount);

	assert.ok(secondPreTrust, "second resolveProjectTrust must receive the bootstrap extensions result");
	const bootstrapNames = names(secondPreTrust);
	assert.ok(
		!bootstrapNames.includes("project.ts"),
		`project extensions must not load during a repeated trust bootstrap, got ${JSON.stringify(bootstrapNames)}`,
	);
	assert.ok(
		bootstrapNames.includes("user.ts") && bootstrapNames.includes("cli.ts"),
		`user and CLI extensions must survive a repeated trust bootstrap, got ${JSON.stringify(bootstrapNames)}`,
	);
	assert.deepEqual(
		secondEvents.find((e) => e[0] === "resolve"),
		["resolve", false],
		`repeated bootstrap must resolve extensions with untrusted settings, events: ${JSON.stringify(secondEvents)}`,
	);
	assert.ok(
		sawSet(secondEvents, false) !== -1 && sawSettings(secondEvents, false) !== -1,
		`repeated bootstrap must force and reload untrusted settings, events: ${JSON.stringify(secondEvents)}`,
	);
}

// --- 3. Direct bootstrap entry point forces untrusted settings.
{
	const { loader, state } = await createTrustSubject(root, { initialTrusted: true });
	assert.equal(loader.constructor.name, "DefaultResourceLoader");
	const bootstrap = await loader.loadProjectTrustExtensions();
	const bootstrapNames = names(bootstrap);
	assert.equal(state.trusted, false, "loadProjectTrustExtensions must leave project settings untrusted for its caller");
	assert.ok(
		!bootstrapNames.includes("project.ts"),
		`loadProjectTrustExtensions must not load project extensions, got ${JSON.stringify(bootstrapNames)}`,
	);
	assert.ok(
		bootstrapNames.includes("user.ts") && bootstrapNames.includes("cli.ts"),
		`loadProjectTrustExtensions must keep user and CLI extensions, got ${JSON.stringify(bootstrapNames)}`,
	);
}

console.log("extension-trust regression: ok");
