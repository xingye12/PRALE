# Contract deliverable — settings resolver precedence (T30)

Repository: `pi` · Mode: `contract`

## Contract

The coding-agent settings resolver must resolve a single value for a setting from three
sources, in this precedence order:

| Priority | Source | Where it lives |
| --- | --- | --- |
| highest | explicit **CLI** value | `SettingsManager.applyOverrides(...)` (parsed flags) |
| middle | **project** value | `<projectDir>/.pi/settings.json` |
| lowest | **user / default** value | `<agentDir>/settings.json` (and built-in defaults) |

The requested experience transfer is a **table-driven assertion**: one fixture's project
value must win over the user/default value, but lose to an explicit CLI value.

## Change

Added `describe("setting precedence", ...)` to
`packages/coding-agent/test/settings-manager.test.ts` (lines 669–754).

- `fixtures` (lines 673–736) is a table where each row declares:
  - `name` — setting under test,
  - `read` — a public getter that returns the resolved value,
  - `user` / `project` / `cli` — the three source partial-settings,
  - `expectedProject` / `expectedCli` — the values the resolver must produce.
- One `it.each(fixtures)` case (lines 738–753) runs every row:
  1. write `user` to `agentDir/settings.json` and `project` to `projectDir/.pi/settings.json`,
  2. `SettingsManager.create(projectDir, agentDir)` and assert `read(manager) === expectedProject`
     (project beats user/default),
  3. `manager.applyOverrides(cli)` and assert `read(manager) === expectedCli`
     (explicit CLI beats project).

Fixtures: `defaultModel`, `theme`, `shellCommandPrefix`, `defaultTools`,
`httpIdleTimeoutMs`, `outputPad`.

## Executable demo / normalized operation result

The package's vitest suite cannot run in this workspace: there is no `node_modules`
and dependency installation is out of scope. As a dependency-free substitute, the
harness `.prale-eval/verify-precedence.mjs` reproduces the contract against the
**repository's real merge code** rather than a mock:

1. It reads `packages/coding-agent/src/core/settings-manager.ts`.
2. It extracts the actual `isMergeableObject` / `deepMergeObjects` / `deepMergeSettings`
   functions, strips their TypeScript annotations, and evaluates them.
3. It models the two resolver steps exactly as the class does:
   `merged = deepMergeSettings(user, project)` then `deepMergeSettings(merged, cli)`
   (mirroring `SettingsManager.create` then `applyOverrides`).
4. It drives the same six-fixture table and asserts both precedence transitions.

Result:

```
$ node .prale-eval/verify-precedence.mjs
precedence contract: 12/12 assertions passed across 6 fixtures
```

The modified test file's TypeScript syntax was separately validated by stripping types
with `node:module` `stripTypeScriptTypes` and running `node --check` on the output
(`SYNTAX OK`).

## Normalized operation result

Given `user`, `project`, `cli` partial settings for a fixture, the resolver produces the
single normalized value `resolve(user, project, cli) = merge(merge(user, project), cli)`,
so the observable outcomes are `resolve(user, project, ∅) = project` and
`resolve(user, project, cli) = cli`, for every fixture in the table.

## Limitation

`npx vitest --run packages/coding-agent/test/settings-manager.test.ts` was **not**
executed because vitest is unavailable without installed dependencies, and installing
them is disallowed. The table-driven test is written against the same behavior the
harness verifies; running the package test suite against an installed dependency tree
remains the canonical end-to-end check.
