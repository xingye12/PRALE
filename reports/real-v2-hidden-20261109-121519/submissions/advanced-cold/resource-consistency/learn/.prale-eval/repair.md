# Untrusted startup leaks project configuration — repair notes

## Incident reconstruction

`ResourceLoader.reload()` performs a two-phase bootstrap when a trust decision is
needed:

1. `loadProjectTrustExtensions()` builds a *pre-trust* extension set that must
   contain only user/global and temporary CLI resources,
2. `resolveProjectTrust({ extensionsResult })` decides the project trust,
3. `settingsManager.setProjectTrusted(decision)` + a second `reload()` admits
   project resources.

Three separate defects broke that chain end to end.

### 1. `packages/coding-agent/src/core/resource-loader.ts` — bootstrap forced trust **on**

`loadProjectTrustExtensions()` called `this.settingsManager.setProjectTrusted(true)`
while its own comment states the bootstrap pass must force *untrusted* project
settings. A manager that was already created as trusted (the common case after
the first session, and the state used by `main.ts`/`package-manager-cli.ts`)
therefore kept its project settings, so the pre-trust pass resolved project
packages/extensions and handed project resources to the trust resolver before
consent — the reported leak. Fix: force `false`.

### 2. `packages/coding-agent/src/core/settings-manager.ts` — trust gate disabled while reading

`SettingsManager.loadFromStorage()` is the single read path used by
`fromStorage()`, `reload()` and `setProjectTrusted(true)`. Its guard had been
neutered to `if (false)`, so the `projectTrusted` argument was ignored and the
project `settings.json` was parsed even for an untrusted project. Project
settings were then merged into the effective view (`getDefaultModel()`,
`getExtensionPaths()`, `compaction`, …) and reached package/extension resolution.
Fix: restore the gate, `if (scope === "project" && !projectTrusted) return {}`.

The guard sits *before* `storage.withLock(scope, …)`, so an untrusted manager now
performs no project settings IO at all — no read, no lock, no parse error.

### 3. `packages/coding-agent/src/core/project-trust.ts` — explicit `false` override lost

`resolveProjectTrusted()` started with `if (options.trustOverride)`; a truthiness
test discards an explicit `false` (and `false` is exactly what `--no-project-trust`
/ `projectTrustOverride: false` produces). The explicit "do not trust" decision
fell through to the extension hook, the persisted store, `defaultProjectTrust`
and finally an interactive prompt. Fix: `if (options.trustOverride !== undefined)`.
An explicit override — `true` **or** `false` — now returns immediately and never
prompts or persists anything.

## Cross-module behaviour after the repair

* `resource-loader` bootstrap → `settings-manager` in untrusted state → package
  resolution sees only global configuration (`defaultModel: global-model`,
  `extensions: [global]`) plus the temporary CLI resources.
* The pre-trust extension set (`cli` + `global`) is what the trust resolver and
  the extension `project_trust` hook observe.
* An explicit override short-circuits `project-trust` before any hook, store
  lookup, default policy or UI prompt.
* A later trusted reload calls `setProjectTrusted(true)`, which re-reads the
  project scope, re-merges it (`deepMergeObjects` keeps recursive nested
  inheritance: project `compaction.reserveTokens` overrides, global
  `compaction.keepRecentTokens` is inherited), and loads only the newly admitted
  project extensions on top of the reused pre-trust runtime.
* Global/CLI resources are preserved in every phase, arrays are replaced rather
  than concatenated, and no public API changed.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` runs the real
`DefaultResourceLoader`, `SettingsManager` and `resolveProjectTrusted` through
`.prale-eval/subject.mjs` (only storage, package-manager, extension-loader,
trust-store and prompt-UI boundaries are substituted). It asserts:

* direct trust resolution: explicit `false`/`true` overrides win without asking
  and without persisting; remembered decisions and `defaultProjectTrust`/no-UI
  behaviour are unchanged; an unknown state still asks exactly once;
* bootstrap reads global configuration only, performs no project settings IO,
  loads `cli` + `global` extensions and publishes nothing project-local;
* an explicit `false` override keeps the run global-only even when a UI and a
  permissive default are available;
* a trusted reload admits the project extension while keeping CLI/global
  resources, merges nested settings recursively, reuses the pre-trust runtime and
  loads only the project extension;
* `loadProjectTrustExtensions()` demotes an already-trusted manager;
* `SettingsManager` alone never reads project storage before consent (verified by
  storage-scope spies and by a corrupt project settings file that only reports a
  parse error after trust is granted).

Mutation check (run locally, then reverted): restoring any single faulty baseline
— `settings-manager.ts` (`if (false)`), `resource-loader.ts`
(`setProjectTrusted(true)`), or `project-trust.ts` (`if (options.trustOverride)`)
— makes the script fail with an `AssertionError` (exit 1), not an import error,
crash or timeout.

Limitation: the repository's own `vitest` suite and TypeScript type checking are
not available in this sandbox (`node_modules` is absent and dependencies must not
be installed), so the regression script above is the validation evidence; the
edited modules are parsed and executed by the real Node 24 TypeScript stripping
loader as part of it.
