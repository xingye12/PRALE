// Dependency-free, executable demonstration of the T17 bootstrap/trust contract.
//
// The workspace has no installed node_modules, so the vitest integration demo
// (packages/coding-agent/test/project-trust-extension-bootstrap.demo.test.ts) cannot be executed here.
// This script still runs with plain `node` and does two things:
//
//  1. Verifies the contract-bearing lines of the real source file
//     packages/coding-agent/src/core/resource-loader.ts still contain the bootstrap-then-trust flow.
//  2. Runs a normalized model of that two-phase flow with a fresh extension fixture and prints the
//     resulting extension set at each phase.
//
// It is a citation/contract check plus a normalized operation result, not a replacement for the
// vitest demo (which imports and executes the real DefaultResourceLoader).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const sourcePath = join(repoRoot, "packages", "coding-agent", "src", "core", "resource-loader.ts");
const sourceLines = readFileSync(sourcePath, "utf-8").split("\n");

// --- 1. Contract verification against the real source -------------------------------
const contractChecks = [
	{ line: 435, mustInclude: "loadProjectTrustExtensions", label: "bootstrap entry point exists" },
	{ line: 438, mustInclude: "setProjectTrusted(false)", label: "bootstrap forces project trust off" },
	{ line: 452, mustInclude: "loadProjectTrustExtensions()", label: "reload runs bootstrap before trust" },
	{ line: 453, mustInclude: "resolveProjectTrust", label: "reload awaits explicit trust decision" },
	{ line: 454, mustInclude: "setProjectTrusted(projectTrusted)", label: "reload applies explicit decision" },
	{ line: 639, mustInclude: "loadFinalExtensionSet", label: "final set is assembled after trust" },
];

const failures = [];
for (const check of contractChecks) {
	const text = sourceLines[check.line - 1] ?? "";
	const ok = text.includes(check.mustInclude);
	console.log(`${ok ? "PASS" : "FAIL"}  line ${check.line}: ${check.label}`);
	if (!ok) failures.push(`line ${check.line} did not contain ${JSON.stringify(check.mustInclude)}`);
}

// --- 2. Normalized two-phase model with a fresh fixture -----------------------------
const fixture = {
	userExtensions: ["<agentDir>/extensions/user.ts"],
	projectExtensions: ["<cwd>/.pi/extensions/project.ts"],
};

// Mirrors package-manager `addAutoDiscoveredResources`: project `.pi/extensions` entries are only
// collected when `settingsManager.isProjectTrusted()` is true; user extensions are always collected.
function resolveEnabledExtensions({ projectTrusted }) {
	return projectTrusted
		? [...fixture.projectExtensions, ...fixture.userExtensions]
		: [...fixture.userExtensions];
}

const bootstrapPhase = resolveEnabledExtensions({ projectTrusted: false }); // loadProjectTrustExtensions
const explicitDecision = { trusted: true };
const finalPhase = resolveEnabledExtensions({ projectTrusted: explicitDecision.trusted }); // loadFinalExtensionSet

const projectWithheldAtBootstrap = !bootstrapPhase.some((p) => p.includes("project.ts"));
const projectAvailableAfterTrust = finalPhase.some((p) => p.includes("project.ts"));

console.log(`${projectWithheldAtBootstrap ? "PASS" : "FAIL"}  bootstrap withholds the fresh project extension`);
console.log(`${projectAvailableAfterTrust ? "PASS" : "FAIL"}  explicit trusted decision makes it available`);
if (!projectWithheldAtBootstrap) failures.push("fresh project extension leaked into the bootstrap set");
if (!projectAvailableAfterTrust) failures.push("fresh project extension missing after trusted decision");

const result = {
	operation: "resource-loader.bootstrap-then-explicit-trust",
	fixture: "fresh",
	bootstrap: { projectTrusted: false, extensions: bootstrapPhase },
	decision: { kind: "explicit", trusted: explicitDecision.trusted },
	final: { projectTrusted: explicitDecision.trusted, extensions: finalPhase },
	contractChecks: failures.length === 0 ? "pass" : "fail",
};
console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
	console.error(`\n${failures.length} contract failure(s):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\nAll contract checks passed.");
