// Focused validation for the settings-resolver precedence contract.
//
// The workspace has no node_modules, so the package's vitest suite cannot run here
// (and installing dependencies is out of scope). Instead of mocking the resolver,
// this harness extracts the *real* merge functions from
// packages/coding-agent/src/core/settings-manager.ts and runs the same fixture
// table that the table-driven assertion in
// packages/coding-agent/test/settings-manager.test.ts encodes.
//
// Contract under test:
//   project value (projectDir/.pi/settings.json)
//     beats user/default value (agentDir/settings.json)
//   explicit CLI value (applyOverrides) beats the project value.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "..", "packages", "coding-agent", "src", "core", "settings-manager.ts");
const src = readFileSync(sourcePath, "utf8");

// --- extract the real merge implementation from the repository source ---------
const start = src.indexOf("function isMergeableObject");
const end = src.indexOf("function parseTimeoutSetting");
assert.ok(start !== -1 && end !== -1 && end > start, "could not locate merge functions in settings-manager.ts");

let block = src.slice(start, end);
block = block
	.replace("(value: unknown): value is Record<string, unknown>", "(value)")
	.replace(
		"(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown>",
		"(base, overrides)",
	)
	.replace("(base: Settings, overrides: Settings): Settings", "(base, overrides)")
	.replace(
		"deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings",
		"deepMergeObjects(base, overrides)",
	);
assert.ok(!/:\s*Record<string, unknown>/.test(block), "type annotations not fully stripped");

const { deepMergeSettings } = new Function(`${block}; return { deepMergeSettings };`)();

// --- resolver semantics mirroring SettingsManager.create + applyOverrides -----
// base = deepMergeSettings(global/user, project); overrides = CLI values.
const resolve = (user, project, cli) => {
	const merged = deepMergeSettings(user, project);
	return cli === undefined ? merged : deepMergeSettings(merged, cli);
};

// --- same fixtures as the table-driven vitest assertion -----------------------
const fixtures = [
	{
		name: "defaultModel",
		get: (s) => s.defaultModel,
		user: { defaultModel: "user-model" },
		project: { defaultModel: "project-model" },
		cli: { defaultModel: "cli-model" },
		expectedProject: "project-model",
		expectedCli: "cli-model",
	},
	{
		name: "theme",
		get: (s) => (typeof s.theme === "string" && !s.theme.includes("/") ? s.theme : undefined),
		user: { theme: "dark" },
		project: { theme: "light" },
		cli: { theme: "solarized-light" },
		expectedProject: "light",
		expectedCli: "solarized-light",
	},
	{
		name: "shellCommandPrefix",
		get: (s) => s.shellCommandPrefix,
		user: { shellCommandPrefix: "user-prefix" },
		project: { shellCommandPrefix: "project-prefix" },
		cli: { shellCommandPrefix: "cli-prefix" },
		expectedProject: "project-prefix",
		expectedCli: "cli-prefix",
	},
	{
		name: "defaultTools",
		get: (s) => (s.defaultTools ? [...s.defaultTools] : undefined),
		user: { defaultTools: ["user-tool"] },
		project: { defaultTools: ["project-tool"] },
		cli: { defaultTools: ["cli-tool"] },
		expectedProject: ["project-tool"],
		expectedCli: ["cli-tool"],
	},
	{
		name: "httpIdleTimeoutMs",
		get: (s) => s.httpIdleTimeoutMs ?? 300000,
		user: { httpIdleTimeoutMs: 300000 },
		project: { httpIdleTimeoutMs: 1000 },
		cli: { httpIdleTimeoutMs: 0 },
		expectedProject: 1000,
		expectedCli: 0,
	},
	{
		name: "outputPad",
		get: (s) => (s.outputPad === 0 ? 0 : 1),
		user: { outputPad: 1 },
		project: { outputPad: 0 },
		cli: { outputPad: 1 },
		expectedProject: 0,
		expectedCli: 1,
	},
];

let passed = 0;
for (const f of fixtures) {
	// project wins over user/default
	assert.deepStrictEqual(
		f.get(resolve(f.user, f.project, undefined)),
		f.expectedProject,
		`${f.name}: project value should beat user/default`,
	);
	// explicit CLI wins over project
	assert.deepStrictEqual(
		f.get(resolve(f.user, f.project, f.cli)),
		f.expectedCli,
		`${f.name}: explicit CLI value should beat project value`,
	);
	passed += 2;
}

console.log(`precedence contract: ${passed}/${fixtures.length * 2} assertions passed across ${fixtures.length} fixtures`);
