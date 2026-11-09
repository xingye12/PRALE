# Repair: untrusted startup leaks project configuration

## Symptom

An already-trusted process that starts a fresh project bootstrap resolved project settings and
loaded project extensions before consent, and an explicit `--project-trust=false` style override
was silently ignored. Three independent defects were chained across the producer/consumer flow:

```
main/CLI ──► DefaultResourceLoader.reload({ resolveProjectTrust })
                 │
                 ├─ 1. loadProjectTrustExtensions()  (bootstrap pass)
                 │      sets SettingsManager trust state, reloads settings,
                 │      resolves packages  ──►  SettingsManager (producer of settings)
                 │                                    └─ loadFromStorage(scope, projectTrusted)
                 │      ... extensions handed to the trust resolver ...
                 │
                 ├─ 2. resolveProjectTrusted(...)  ──► boolean decision
                 │      (explicit override / extension hook / store / default / prompt)
                 │
                 └─ 3. setProjectTrusted(decision); reload(); final resource set
```

## Fixes (one per module)

### `packages/coding-agent/src/core/resource-loader.ts`

`loadProjectTrustExtensions()` documents "force untrusted project settings for the bootstrap
pass" but called `settingsManager.setProjectTrusted(true)`. The bootstrap pass therefore ran with
the project trusted, so the package manager resolved and loaded project extensions *before* the
trust decision was requested. It now calls `setProjectTrusted(false)`.

### `packages/coding-agent/src/core/settings-manager.ts`

`SettingsManager.loadFromStorage(storage, scope, projectTrusted)` accepted `projectTrusted` but
never used it (`if (false)`), so project settings were parsed regardless of trust. The guard is
now `if (scope === "project" && !projectTrusted) return {};`. This makes the trust state an
actual producer-side invariant for every consumer: initial construction
(`fromStorage(..., { projectTrusted: false })`), `reload()` (which passes
`this.projectTrusted`), and `setProjectTrusted(true)` when a trusted reload admits project
settings.

### `packages/coding-agent/src/core/project-trust.ts`

`resolveProjectTrusted()` used `if (options.trustOverride)`, which treats an explicit `false`
exactly like "no override": the resolver then consulted the `project_trust` extension hook, the
stored decision, the default policy and finally the interactive prompt. The guard is now
`if (options.trustOverride !== undefined)`, so an explicit override — including `false` — wins
immediately and never prompts or emits extension events.

## Preserved behavior

* Global (`agentDir/settings.json`) and CLI/temporary extension sources still load during the
  bootstrap pass and in the final reload.
* Nested settings inheritance is unchanged: `deepMergeSettings(global, project)` still merges
  nested objects, so a trusted reload keeps global `compaction.keepRecentTokens` while a project
  `compaction.reserveTokens` overrides it.
* `setProjectTrusted(false)` still drops project settings and project write access
  (`assertProjectTrustedForWrite`), and `setProjectTrusted(true)` still loads them.
* No API, signature or unrelated behavior was changed.

## Validation

`.prale-eval/regression.mjs` links the real `resource-loader.ts`, `settings-manager.ts`,
`project-trust.ts` modules through the read-only `.prale-eval/subject.mjs` harness (only the
package manager, extension loader, trust store and UI are faked) and asserts cross-module
observables:

1. Fresh untrusted bootstrap: inside the `resolveProjectTrust` callback the settings manager is
   still untrusted, the effective settings are global-only (nested global values intact), the
   extension set handed to the resolver contains only CLI + global extensions, and every
   bootstrap resolution logs `("resolve", false, "global-model")`.
2. Explicit `false` override with an approving UI, a stored "trusted" decision and an extension
   hook that would answer "yes": the result is `false`, the `project_trust` hook is never emitted
   and nothing is written to the trust store. The direct resolver contract is checked for both
   `false` and `true` overrides.
3. Remembered consent: bootstrap still global/CLI only, then the trusted reload admits
   `project.ts` alongside `cli.ts`/`global.ts`, with project overrides winning and global nested
   values inherited.
4. `defaultProjectTrust: "never"` keeps project resources out, and `SettingsManager` is checked
   directly across `fromStorage(untrusted)`, `reload()`, `setProjectTrusted(true)` and
   `setProjectTrusted(false)`.

Mutation check performed locally (each file reverted alone to its faulty baseline, verified via
`AssertionError`, then restored):

| Reverted file | Detected by |
| --- | --- |
| `resource-loader.ts` | "bootstrap must run with the project untrusted" |
| `settings-manager.ts` | "bootstrap must read only global settings" |
| `project-trust.ts` | "an explicit false override must win" |

## Limitation

The repository's own `vitest` suites (`packages/coding-agent/test/resource-loader.test.ts`,
`settings-manager.test.ts`) cannot be executed in this workspace because `node_modules` is not
installed and dependencies must not be installed here; the harness-independent regression script
above is the validation artifact instead.
