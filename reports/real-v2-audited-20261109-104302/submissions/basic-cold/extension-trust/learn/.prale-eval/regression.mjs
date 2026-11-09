/**
 * Regression for extension-trust/learn.
 *
 * Bootstrap must force UNTRUSTED project settings before it reloads settings and
 * resolves extensions, even when the loader/settings currently regard the project
 * as trusted. Project-local extensions must therefore stay out of the pre-trust
 * extension set, while user/global and temporary CLI extensions stay available.
 * Once project trust is resolved, the loader must honour that decision.
 *
 * The script drives the real DefaultResourceLoader from
 * packages/coding-agent/src/core/resource-loader.ts through the boundary fakes
 * exposed by .prale-eval/subject.mjs.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const { createTrustSubject } = await import(new URL("./subject.mjs", import.meta.url).href);

// Array.from keeps host-realm arrays: extension lists produced by the VM realm
// have a different Array.prototype, which deepStrictEqual would reject.
const basenames = (extensions) => Array.from(extensions, (extension) => path.basename(extension.path)).sort();

/** Run one reload of the real loader, recording the state seen at trust resolution. */
async function reloadWithTrust(loader, events, state, projectTrusted) {
	const start = events.length;
	const seen = [];
	await loader.reload({
		async resolveProjectTrust({ extensionsResult }) {
			seen.push({
				extensions: extensionsResult.extensions,
				trusted: state.trusted,
				loadedTrust: state.loadedTrust,
			});
			events.push(["resolveProjectTrust", projectTrusted]);
			return projectTrusted;
		},
	});
	return { start, seen, events: events.slice(start) };
}

const describe = (value) => JSON.stringify(value);

async function assertBootstrapForcesUntrusted({ initialTrusted, projectTrusted }) {
	const subject = await createTrustSubject(root, { initialTrusted });
	assert.equal(subject.state.trusted, initialTrusted, "fixture should start in the requested trust state");

	const { seen, events } = await reloadWithTrust(subject.loader, subject.events, subject.state, projectTrusted);
	assert.equal(seen.length, 1, `reload must resolve project trust exactly once, saw ${seen.length}`);

	// 1. The very first thing the bootstrap does is force trust to false, before
	//    any settings reload or extension resolution happens.
	assert.deepEqual(
		events[0],
		["set", false],
		`bootstrap must force untrusted settings first, but the first event was ${describe(events[0])} (all: ${describe(events)})`,
	);
	assert.deepEqual(
		events[1],
		["settings", false],
		`bootstrap must reload settings while untrusted, but event 1 was ${describe(events[1])} (all: ${describe(events)})`,
	);

	const preResolution = events.slice(0, events.findIndex((event) => event[0] === "resolveProjectTrust"));
	const firstResolve = preResolution.find((event) => event[0] === "resolve");
	assert.ok(firstResolve, `bootstrap must resolve extensions before trust is resolved (all: ${describe(events)})`);
	assert.deepEqual(
		firstResolve,
		["resolve", false],
		`bootstrap must resolve extensions with untrusted settings, but got ${describe(firstResolve)} (all: ${describe(events)})`,
	);

	// 2. Nothing project-scoped may be loaded during the bootstrap pass.
	for (const event of preResolution) {
		if (event[0] !== "extensions") continue;
		assert.ok(
			!event[1].includes("project.ts"),
			`bootstrap must not load project extensions before trust is resolved, saw ${describe(event)}`,
		);
	}

	// 3. User/global and CLI extensions stay available to the trust decision.
	const atTrust = seen[0];
	assert.equal(
		atTrust.trusted,
		false,
		`settings must be untrusted while project trust is being resolved (all: ${describe(events)})`,
	);
	assert.equal(
		atTrust.loadedTrust,
		false,
		`the package manager must see the untrusted bootstrap state (all: ${describe(events)})`,
	);
	assert.deepEqual(
		basenames(atTrust.extensions),
		["cli.ts", "user.ts"],
		`pre-trust extensions must be exactly the user and CLI extensions, saw ${describe(basenames(atTrust.extensions))}`,
	);

	// 4. The resolved trust decision is honoured for the final extension set.
	const lastSet = [...events].reverse().find((event) => event[0] === "set");
	assert.deepEqual(
		lastSet,
		["set", projectTrusted],
		`the resolved project trust (${projectTrusted}) must be applied, saw ${describe(lastSet)}`,
	);

	const finalExtensions = basenames(subject.loader.getExtensions().extensions);
	const expected = projectTrusted ? ["cli.ts", "project.ts", "user.ts"] : ["cli.ts", "user.ts"];
	assert.deepEqual(
		finalExtensions,
		expected,
		`final extensions should follow the resolved trust state, saw ${describe(finalExtensions)} (all: ${describe(events)})`,
	);
	if (projectTrusted) {
		assert.ok(
			events.some((event) => event[0] === "extensions" && event[1].includes("project.ts")),
			`project extensions must load after trust is granted (all: ${describe(events)})`,
		);
	}
	return { subject, events: subject.events };
}

// Case 1: previous state was trusted; bootstrap must still force untrusted.
const trustedStart = await assertBootstrapForcesUntrusted({ initialTrusted: true, projectTrusted: true });

// Case 2: a second reload of the same (now trusted) loader must force untrusted again.
{
	const { subject, events } = trustedStart;
	assert.ok(events === subject.events, "helper must expose the live event log");
	const before = events.length;
	const seen = [];
	await subject.loader.reload({
		async resolveProjectTrust({ extensionsResult }) {
			seen.push({ extensions: extensionsResult.extensions, trusted: subject.state.trusted });
			events.push(["resolveProjectTrust", true]);
			return true;
		},
	});
	const secondReload = events.slice(before);
	assert.equal(seen.length, 1, "second reload must resolve project trust exactly once");
	assert.equal(
		seen[0].trusted,
		false,
		`second reload must resolve trust while settings are untrusted (all: ${describe(secondReload)})`,
	);
	assert.deepEqual(
		secondReload[0],
		["set", false],
		`every reload must re-bootstrap untrusted, but the second reload started with ${describe(secondReload[0])} (all: ${describe(secondReload)})`,
	);
	const firstResolve = secondReload.find((event) => event[0] === "resolve");
	assert.deepEqual(
		firstResolve,
		["resolve", false],
		`every reload must resolve with untrusted settings, saw ${describe(firstResolve)} (all: ${describe(secondReload)})`,
	);
	assert.deepEqual(
		basenames(seen[0].extensions),
		["cli.ts", "user.ts"],
		`second reload's pre-trust extensions must exclude the project extension, saw ${describe(basenames(seen[0].extensions))}`,
	);
	assert.ok(
		!secondReload.slice(0, secondReload.findIndex((event) => event[0] === "resolveProjectTrust")).some(
			(event) => event[0] === "extensions" && event[1].includes("project.ts"),
		),
		`second reload must not preload project extensions (all: ${describe(secondReload)})`,
	);
}

// Case 3: started and resolved untrusted — project extensions never load.
await assertBootstrapForcesUntrusted({ initialTrusted: false, projectTrusted: false });

console.log("ok - bootstrap forces untrusted settings before resolving extensions");
