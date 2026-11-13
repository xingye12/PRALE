/**
 * Regression for extension-trust/transfer.
 *
 * Fault: DefaultResourceLoader.reload() resolved the explicit project-trust decision and then
 * unconditionally called settingsManager.setProjectTrusted(false), so a "trusted" decision was
 * discarded after the untrusted bootstrap pass. Project settings were never reloaded for the
 * resolved trust state and project extensions could never be loaded.
 *
 * The script drives the real source through .prale-eval/subject.mjs boundary fakes and asserts:
 *   1. declining trust keeps project extensions out of every pass,
 *   2. an explicit true decision is honored: settings are reloaded as trusted *before* final
 *      resource resolution and the project extension ends up loaded,
 *   3. the bootstrap pass itself always stays untrusted.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTrustSubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const isEvent = (event, kind) => Array.isArray(event) && event[0] === kind;
const of = (events, kind) =>
	Array.from(events, (event) => event).filter((event) => isEvent(event, kind)).map((event) => event[1]);
const extensionNames = (events) => of(events, "extensions").map((names) => Array.from(names));
const lastIndex = (events, kind, value) => {
	let found = -1;
	events.forEach((event, index) => {
		if (isEvent(event, kind) && (value === undefined || event[1] === value)) found = index;
	});
	return found;
};
const basenames = (extensionsResult) =>
	Array.from(extensionsResult.extensions, (extension) => path.basename(extension.path));

// --- 1. Declining trust keeps project extensions out of every pass -------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	await loader.reload({ resolveProjectTrust: async () => false });

	const loads = extensionNames(events);
	assert.ok(loads.length >= 1, "expected the loader to resolve extensions at least once");
	for (const names of loads) {
		assert.ok(
			!names.includes("project.ts"),
			`project extension must stay unloaded when trust is declined, got loads: ${JSON.stringify(loads)}`,
		);
	}
	assert.deepEqual(of(events, "resolve"), [false, false], "declined trust must resolve resources untrusted");
	assert.equal(state.trusted, false, "the resolved false decision must be stored on the settings manager");
	assert.equal(state.loadedTrust, false, "settings must be reloaded with the resolved false decision");
	assert.deepEqual(basenames(loader.getExtensions()), ["cli.ts", "user.ts"]);
}

// --- 2. Granting trust is honored after the bootstrap pass ---------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	const decisionsSeen = [];
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			decisionsSeen.push(basenames(extensionsResult));
			return true;
		},
	});

	assert.equal(decisionsSeen.length, 1, "the trust hook must be invoked exactly once");
	assert.deepEqual(
		decisionsSeen[0],
		["cli.ts", "user.ts"],
		"the bootstrap extensions handed to the trust hook must exclude project extensions",
	);

	const loads = extensionNames(events);
	assert.ok(
		!loads[0].includes("project.ts"),
		`bootstrap must not load project extensions, got: ${JSON.stringify(loads[0])}`,
	);
	assert.equal(state.trusted, true, "the resolved true decision must be stored on the settings manager");
	assert.equal(state.loadedTrust, true, "settings must be reloaded with the resolved true decision");

	assert.deepEqual(of(events, "resolve"), [false, true], "final resource resolution must run trusted");
	const setIndex = lastIndex(events, "set", true);
	const reloadIndex = lastIndex(events, "settings", true);
	const resolveIndex = lastIndex(events, "resolve", true);
	assert.ok(setIndex >= 0, "the resolved true decision must be applied to the settings manager");
	assert.ok(
		reloadIndex > setIndex && resolveIndex > reloadIndex,
		`settings must be reloaded after applying trust and before final resolution, got: ${JSON.stringify(events)}`,
	);

	assert.deepEqual(
		basenames(loader.getExtensions()),
		["cli.ts", "user.ts", "project.ts"],
		"a trusted decision must let the project extension load after bootstrap",
	);
}

// --- 3. The bootstrap pass itself always stays untrusted ----------------------------------
{
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted: true });
	const bootstrap = await loader.loadProjectTrustExtensions();

	assert.deepEqual(
		basenames(bootstrap),
		["cli.ts", "user.ts"],
		"bootstrap must keep project extensions excluded",
	);
	assert.deepEqual(extensionNames(events), [["cli.ts", "user.ts"]], "bootstrap must load only user and CLI extensions");
	assert.deepEqual(of(events, "resolve"), [false], "bootstrap must resolve resources as untrusted");
	assert.equal(state.trusted, false, "bootstrap must force untrusted project settings");
}
