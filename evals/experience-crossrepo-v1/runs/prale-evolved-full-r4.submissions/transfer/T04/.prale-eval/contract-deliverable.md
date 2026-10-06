# T04 contract deliverable — project-vs-user-vs-CLI precedence assertion (`pi`)

## What the contract is

For a settings fixture resolved by `SettingsManager`, value provenance follows this order
(highest wins):

1. **explicit CLI value** — applied in memory via `SettingsManager.applyOverrides(...)`
   (the path `packages/coding-agent/src/main.ts` uses for `--use-theme`),
2. **project settings** — `<projectDir>/.pi/settings.json`,
3. **user/global settings** — `<agentDir>/settings.json`,
4. **built-in default**.

The contract under test is narrower than "everything merges": for the `theme` fixture the
**project** value must beat the **user/global** value and the **default**, and must
**lose** to an **explicit CLI value**.

## Executable demo (the added test)

File: `packages/coding-agent/test/settings-manager.test.ts`
Block: `describe("settings precedence", ...)` (lines 669–715).

The table `themePrecedenceCases` (lines 674–697) drives `it.each(themePrecedenceCases)`
(lines 699–714). Each row writes the settings files it names, creates the manager, optionally
applies the CLI layer, and asserts the observed theme:

| row (`layer`) | user file | project file | CLI override | expected `getTheme()` |
| --- | --- | --- | --- | --- |
| built-in default when nothing is configured | — | — | — | `undefined` |
| user/global value over the default | `user-theme` | — | — | `user-theme` |
| project value over the user value | `user-theme` | `project-theme` | — | `project-theme` |
| explicit CLI value over the project value | `user-theme` | `project-theme` | `cli-theme` | `cli-theme` |

Rows 3 and 4 are the requested assertion: the project value wins over user/default, and then
loses to the explicit CLI value.

```ts
it.each(themePrecedenceCases)("resolves theme from the $layer", ({ userTheme, projectTheme, cliTheme, expected }) => {
    if (userTheme !== undefined) {
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: userTheme }));
    }
    if (projectTheme !== undefined) {
        writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: projectTheme }));
    }

    const manager = SettingsManager.create(projectDir, agentDir);

    if (cliTheme !== undefined) {
        manager.applyOverrides({ theme: cliTheme });
    }

    expect(manager.getTheme()).toBe(expected);
});
```

## Why the assertion is faithful to the source

- `SettingsManager.create()` merges user/global then project settings
  (`deepMergeSettings(this.globalSettings, this.projectSettings)`), so project wins over
  user/default.
- `applyOverrides()` (`packages/coding-agent/src/core/settings-manager.ts`, lines 568–570)
  re-merges the given overrides on top of the current merged settings and keeps them
  **in memory only** — it does not mark the field modified or write the file. This is exactly
  the "explicit CLI value" layer (`main.ts` line 667 applies `{ theme: parsed.useTheme }`).
- `getTheme()` (lines 788–791) returns the merged `theme`, so it is the observable that
  exposes the winning layer.

Because the four rows use four distinct expected values, the table is discriminating: any
ordering mistake (project not overriding user, or CLI not overriding project) fails the run.

## How to run

```sh
cd packages/coding-agent
npx vitest run test/settings-manager.test.ts
```

Focused subset only:

```sh
cd packages/coding-agent
npx vitest run test/settings-manager.test.ts -t "settings precedence"
```

## Validation status and limitations

`vitest` (4.1.9) is declared in `packages/coding-agent/package.json`, but this checkout has no
`node_modules` and dependency installation is out of scope, so the canonical command above
could not be executed here. **Limitation recorded rather than worked around by installing
dependencies.**

Substitute checks actually performed inside the workspace:

1. `node --experimental-strip-types --check packages/coding-agent/test/settings-manager.test.ts`
   → exit 0 (the edited file parses).
2. A temporary offline harness (a minimal `vitest` shim plus stubs for `proper-lockfile`,
   `undici`, `@earendil-works/pi-ai` and `cross-spawn`, wired through a Node
   module-resolution loader) imported the real `src/core/settings-manager.ts` and ran the
   tests:
   - new `settings precedence` block: **4 passed / 0 failed**;
   - whole `settings-manager.test.ts`: **50 passed / 0 failed**.

   The harness was removed afterwards, so the only workspace change is the test file.

## Files changed

- `packages/coding-agent/test/settings-manager.test.ts` — added the `settings precedence`
  table-driven block (48 inserted lines). No task metadata, hidden-oracle file, package lock,
  or git configuration was modified.
