# Contract: settings precedence across default, user/global, project fixture, and CLI layers

Repository: `pi` — package `@earendil-works/pi-coding-agent`
Resolver: `SettingsManager` (`packages/coding-agent/src/core/settings-manager.ts`)
Executable assertion: `packages/coding-agent/test/settings-manager.test.ts`

## Contract statement

`SettingsManager` resolves a setting by folding an ordered stack of layers, where a later
layer wins over every earlier one:

| # | Layer | Source | Resolved by |
|---|-------|--------|-------------|
| 1 | built-in default | hard-coded fallback in the getter | getter (`getTheme()` returns `undefined` here) |
| 2 | user / global | `<agentDir>/settings.json` | `loadFromStorage(..., "global")` |
| 3 | project fixture | `<projectDir>/.pi/settings.json` | `loadFromStorage(..., "project")` |
| 4 | explicit CLI value | `applyOverrides(...)` | `applyOverrides` (called from `main.ts` for `--use-theme`) |

The stack is folded by `deepMergeSettings(base, overrides)`:
`settings = deepMerge(global, project)` in the constructor, then
`settings = deepMerge(settings, cliOverrides)` in `applyOverrides`.
Because the project layer is merged *after* global and *before* overrides, a project
fixture value **wins over user/default but loses to an explicit CLI value**.

Contract, stated as an executable assertion (`theme` used as the fixture key):

- no layer set → default (`undefined`)
- global only → global wins (`"dark"`)
- global + project → **project wins** (`"light"`)
- global + project + CLI → **CLI wins** (`"solarized-light"`)

## Executable demo

Added to the `SettingsManager` suite in
`packages/coding-agent/test/settings-manager.test.ts`:

```ts
// Precedence contract for a project settings fixture: the fixture's project value
// beats the user/global value and the built-in default, but an explicit CLI value
// (applied through applyOverrides, the same path `--use-theme` takes in main.ts)
// beats the project value. Table-driven so each layer boundary is asserted directly.
describe("setting precedence across default, user/global, project, and CLI layers", () => {
	const precedenceCases: Array<{
		name: string;
		globalTheme?: string;
		projectTheme?: string;
		cliTheme?: string;
		expected: string | undefined;
	}> = [
		{ name: "falls back to the default when no layer sets the value", expected: undefined },
		{ name: "uses the user/global value when the project fixture has none", globalTheme: "dark", expected: "dark" },
		{ name: "lets the project fixture value win over the user/global value", globalTheme: "dark", projectTheme: "light", expected: "light" },
		{ name: "lets an explicit CLI value win over the project fixture value", globalTheme: "dark", projectTheme: "light", cliTheme: "solarized-light", expected: "solarized-light" },
	];

	it.each(precedenceCases)("$name", ({ globalTheme, projectTheme, cliTheme, expected }) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalTheme ? { theme: globalTheme } : {}));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(projectTheme ? { theme: projectTheme } : {}));

		const manager = SettingsManager.create(projectDir, agentDir);
		if (cliTheme !== undefined) {
			manager.applyOverrides({ theme: cliTheme });
		}

		expect(manager.getTheme()).toBe(expected);
	});
});
```

The fixture layers are materialized as real files: the global layer in
`<agentDir>/settings.json`, the project fixture in `<projectDir>/.pi/settings.json`.
The explicit CLI value is injected through `applyOverrides({ theme })`, which is exactly
what the CLI does for `--use-theme` in `main.ts` (`startupSettingsManager.applyOverrides({ theme: parsed.useTheme })`).

The table is the contract: each row pins one layer boundary, so a regression that changes
merge order (for example merging project before global, or overrides before project)
fails a named case rather than passing silently.

## Normalized operation result

| case | global | project | CLI | `getTheme()` |
|------|--------|---------|-----|--------------|
| default | – | – | – | `undefined` |
| user/global | `dark` | – | – | `dark` |
| project beats user | `dark` | `light` | – | `light` |
| CLI beats project | `dark` | `light` | `solarized-light` | `solarized-light` |

## How to run

```sh
npm --prefix packages/coding-agent test -- --run test/settings-manager.test.ts
# or, from packages/coding-agent:
npx vitest --run test/settings-manager.test.ts
```

## Validation status

`vitest` could not be executed in this environment: the repository has no installed
`node_modules` and dependency installation is out of scope for this task. The modified
test file was instead checked for TypeScript syntax validity with
`node --experimental-strip-types --check`, which passed. The full test run remains to be
executed in a provisioned checkout.
