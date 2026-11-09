/**
 * Regression for extension trust transfer after bootstrap.
 *
 * Exercises the real DefaultResourceLoader lifecycle through the read-only
 * subject helper. The boundary fakes report which trust state each settings
 * reload actually persisted and which extensions the package manager resolved
 * from that state.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustSubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basenames = (extensionsResult) =>
	extensionsResult.extensions.map((extension) => path.basename(extension.path));
const sameMembers = (actual, expected) =>
	assert.deepEqual([...actual].sort(), [...expected].sort());

async function exercise({ initialTrusted, decision, label }) {
	const { loader, events, state } = await createTrustSubject(root, { initialTrusted });

	const decisions = [];
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			decisions.push(basenames(extensionsResult));
			return decision;
		},
	});

	assert.equal(decisions.length, 1, `${label}: resolveProjectTrust must run exactly once`);

	// Bootstrap must never expose project-local extensions to the trust decision.
	const bootstrapExtensions = decisions[0];
	assert.ok(
		!bootstrapExtensions.includes("project.ts"),
		`${label}: project extension leaked into the bootstrap pass: ${bootstrapExtensions.join(", ")}`,
	);
	sameMembers(bootstrapExtensions, ["user.ts", "cli.ts"]);

	// The decision must be applied to settings and reloaded before final resolution.
	const resolveEvents = events
		.map((event, index) => (event[0] === "resolve" ? index : -1))
		.filter((index) => index !== -1);
	assert.ok(resolveEvents.length >= 2, `${label}: expected bootstrap and final resolve events`);

	const bootstrapResolveIndex = resolveEvents[0];
	assert.equal(
		events[bootstrapResolveIndex][1],
		false,
		`${label}: bootstrap must resolve packages with project trust disabled`,
	);

	const finalResolveIndex = resolveEvents[resolveEvents.length - 1];
	const settingsBeforeFinal = events
		.slice(0, finalResolveIndex)
		.filter((event) => event[0] === "settings");
	const finalSettings = settingsBeforeFinal[settingsBeforeFinal.length - 1];
	assert.ok(
		finalSettings !== undefined,
		`${label}: settings were never reloaded before final resource resolution`,
	);
	assert.equal(
		finalSettings[1],
		decision,
		`${label}: settings were reloaded with ${finalSettings[1]} instead of the explicit decision ${decision}`,
	);
	assert.equal(
		events[finalResolveIndex][1],
		decision,
		`${label}: final package resolution saw trust ${events[finalResolveIndex][1]} instead of ${decision}`,
	);
	assert.equal(state.trusted, decision, `${label}: settings manager retained the wrong trust state`);

	// The final extension set must follow the decision, while user/CLI stay loaded.
	const finalExtensions = basenames(loader.getExtensions());
	if (decision) {
		sameMembers(finalExtensions, ["user.ts", "project.ts", "cli.ts"]);
	} else {
		sameMembers(finalExtensions, ["user.ts", "cli.ts"]);
		assert.ok(
			!finalExtensions.includes("project.ts"),
			`${label}: project extension loaded despite an explicit false decision`,
		);
	}
}

// An explicit true must be honored even when the previous state was untrusted.
await exercise({ initialTrusted: false, decision: true, label: "explicit true" });

// An explicit false must be honored even when the previous state was trusted.
await exercise({ initialTrusted: true, decision: false, label: "explicit false" });

console.log("trust transfer regression passed");
