/**
 * Regression: a denied project-trust decision must not be treated as approval.
 *
 * Exercises the real DefaultResourceLoader.reload() lifecycle through
 * .prale-eval/subject.mjs. Phase separation under test:
 *   - bootstrap pass: project resources absent, user/global + CLI present
 *   - decision === false: project resources stay absent, user + CLI still present
 *   - decision === true: project resources become available, user + CLI still present
 *
 * The original fault pins the post-decision trust state to true, so a denial
 * surfaces project resources and is observable here as a failed assertion.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Extension names ("user", "project", "cli") in load order. */
const extensionNames = (extensionsResult) =>
	extensionsResult.extensions.map((extension) => path.basename(extension.path, ".ts"));

const sorted = (names) => [...names].sort();

const resolvesObserved = (events) => events.filter((event) => event[0] === "resolve").map((event) => event[1]);

function assertPresent(actual, required, scenario) {
	for (const name of required) {
		assert.ok(
			actual.includes(name),
			`${scenario}: expected the ${name} extension to be available, got [${actual.join(", ")}]`,
		);
	}
}

function assertAbsent(actual, forbidden, scenario) {
	for (const name of forbidden) {
		assert.ok(
			!actual.includes(name),
			`${scenario}: expected the ${name} extension to be unavailable, got [${actual.join(", ")}]`,
		);
	}
}

let checks = 0;

// --- Scenario 1: denial -----------------------------------------------------
{
	const scenario = "denied trust decision";
	const { loader, events, state } = await createTrustSubject(workspaceRoot, { initialTrusted: true });

	let bootstrapNames;
	let bootstrapLoadTimeResolve;
	let bootstrapTrusted;
	let bootstrapLoadedTrust;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = extensionNames(extensionsResult);
			bootstrapLoadTimeResolve = resolvesObserved(events).at(-1);
			// Snapshot the settings state the bootstrap pass ran under, before any decision is applied.
			bootstrapTrusted = state.trusted;
			bootstrapLoadedTrust = state.loadedTrust;
			return false;
		},
	});

	// Bootstrap pass: no project resources, but user/global and CLI are available.
	assert.deepEqual(
		sorted(bootstrapNames),
		["cli", "user"],
		`${scenario}: bootstrap extensions must exclude project resources and include user + CLI, got [${bootstrapNames.join(", ")}]`,
	);
	assert.equal(
		bootstrapLoadTimeResolve,
		false,
		`${scenario}: package resolution during bootstrap must observe untrusted settings, saw trusted=${bootstrapLoadTimeResolve}`,
	);
	assert.equal(
		bootstrapTrusted,
		false,
		`${scenario}: bootstrap must force project settings to untrusted, saw trusted=${bootstrapTrusted}`,
	);
	assert.equal(
		bootstrapLoadedTrust,
		false,
		`${scenario}: bootstrap must reload settings as untrusted, saw trusted=${bootstrapLoadedTrust}`,
	);
	checks += 4;

	// Final pass: the denial is not approval.
	const finalNames = extensionNames(loader.getExtensions());
	assertAbsent(finalNames, ["project"], scenario);
	assertPresent(finalNames, ["user", "cli"], scenario);
	assert.equal(
		state.trusted,
		false,
		`${scenario}: reloaded settings must keep project untrusted after a denial, got trusted=${state.trusted}`,
	);
	assert.equal(state.loadedTrust, false, `${scenario}: reload must load settings for the denied trust state`);
	assert.equal(
		resolvesObserved(events).at(-1),
		false,
		`${scenario}: final package resolution must observe the denied trust state`,
	);
	checks += 5;

	// A subsequent reload on the same loader must not silently inherit approval.
	await loader.reload();
	const afterReloadNames = extensionNames(loader.getExtensions());
	assertAbsent(afterReloadNames, ["project"], `${scenario}: fresh reload`);
	assertPresent(afterReloadNames, ["user", "cli"], `${scenario}: fresh reload`);
	assert.equal(
		state.trusted,
		false,
		`${scenario}: fresh reload must not flip a denied decision to trusted, got trusted=${state.trusted}`,
	);
	checks += 3;
}

// --- Scenario 2: approval ---------------------------------------------------
{
	const scenario = "granted trust decision";
	const { loader, events, state } = await createTrustSubject(workspaceRoot, { initialTrusted: false });

	let bootstrapNames;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapNames = extensionNames(extensionsResult);
			return true;
		},
	});

	assert.deepEqual(
		sorted(bootstrapNames),
		["cli", "user"],
		`${scenario}: bootstrap extensions must still exclude project resources, got [${bootstrapNames.join(", ")}]`,
	);

	const finalNames = extensionNames(loader.getExtensions());
	assertPresent(finalNames, ["project", "user", "cli"], scenario);
	assert.equal(
		state.trusted,
		true,
		`${scenario}: approval must reload project settings as trusted, got trusted=${state.trusted}`,
	);
	assert.equal(state.loadedTrust, true, `${scenario}: reload must load settings for the approved trust state`);
	assert.equal(
		resolvesObserved(events).at(-1),
		true,
		`${scenario}: final package resolution must observe the approved trust state`,
	);
	checks += 5;
}

assert.ok(checks >= 15, `expected the regression to execute every phase check, ran ${checks}`);
console.log(`resource-loader trust phase separation: ${checks} assertions passed`);
