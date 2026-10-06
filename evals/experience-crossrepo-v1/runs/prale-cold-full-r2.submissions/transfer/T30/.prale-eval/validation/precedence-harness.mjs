// Focused executable validation for the new table-driven "settings precedence" test in
// packages/coding-agent/test/settings-manager.test.ts.
//
// Vitest is not installed in this workspace (no node_modules, and dependencies must not be
// installed), so this harness loads the real SettingsManager source through Node's type stripping
// plus the module stubs/hooks in this directory, and replays exactly the assertions of the new
// table-driven fixture.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";

const root = join(import.meta.dirname, "tmp");
const agentDir = join(root, "agent");
const projectDir = join(root, "project");

function reset() {
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
}

// Same fixture row as the test table.
const fixture = {
	name: "theme",
	defaultValue: undefined,
	userSettings: { theme: "light" },
	projectSettings: { theme: "solarized-light" },
	cliOverrides: { theme: "tokyo-night" },
	read: (manager) => manager.getThemeSetting(),
};

const results = [];
function check(layer, actual, expected) {
	assert.deepStrictEqual(actual, expected, `${layer}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	results.push(`${fixture.name} / ${layer}: ${JSON.stringify(actual)}`);
}

reset();
try {
	// Default layer: nothing configured anywhere.
	check("default (inMemory, unset)", fixture.read(SettingsManager.inMemory()), fixture.defaultValue);

	// User (global) layer applies while the project has not set the value.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(fixture.userSettings));
	const userManager = SettingsManager.create(projectDir, agentDir);
	check("user/global", fixture.read(userManager), fixture.userSettings.theme);

	// Project value wins over user/default.
	writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(fixture.projectSettings));
	const projectManager = SettingsManager.create(projectDir, agentDir);
	check("project over user/default", fixture.read(projectManager), fixture.projectSettings.theme);

	// Explicit CLI value wins over the project value.
	projectManager.applyOverrides(fixture.cliOverrides);
	check("explicit CLI over project", fixture.read(projectManager), fixture.cliOverrides.theme);
} finally {
	reset();
	rmSync(root, { recursive: true, force: true });
}

console.log(`PASS: ${results.length} precedence assertions`);
for (const line of results) console.log(`  ${line}`);
