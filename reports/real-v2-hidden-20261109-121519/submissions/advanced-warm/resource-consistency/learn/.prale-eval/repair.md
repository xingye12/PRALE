# Repair: untrusted startup leaked project configuration

## Symptom

An already-trusted process that started a fresh project bootstrap observed
project configuration (project `settings.json`, project extensions and the
resulting extension load set) *before* consent was resolved. An explicit
`--project-trust=false` override was also silently ignored.

Three production files had each lost one half of the trust boundary, so the
leak needed a cross-module repair.

## Faults found

1. `packages/coding-agent/src/core/resource-loader.ts`
   `loadProjectTrustExtensions()` — the bootstrap pass (the one that loads
   extensions so `project_trust` handlers can run) called
   `settingsManager.setProjectTrusted(true)`. The pre-trust pass therefore
   re-read project settings, resolved project packages and executed project
   extensions before the trust resolver had been consulted.

   Fix: force the pre-trust pass untrusted (`setProjectTrusted(false)`), which
   is what the method's own comment promises. Global/user and temporary CLI
   extensions are still loaded, because the trust boundary only gates project
   resources (`packageManager.resolve()` reads global settings plus (empty)
   project settings, `resolveExtensionSources()` is unaffected).

2. `packages/coding-agent/src/core/settings-manager.ts`
   `SettingsManager.loadFromStorage(storage, scope, projectTrusted)` — the
   `projectTrusted` argument was accepted and threaded through every caller
   (`fromStorageWithPaths`, `setProjectTrusted`, `reload`) but the guard had
   become a no-op. Project settings were parsed (and project `withLock` reads
   performed) even for an untrusted manager, so `setProjectTrusted(false)` and
   `reload()` still merged project values into the effective settings.

   Fix: skip reading the project scope whenever the manager is untrusted
   (`scope === "project" && !projectTrusted`). Global scope, nested
   `deepMergeSettings` inheritance and the trusted path are unchanged.

3. `packages/coding-agent/src/core/project-trust.ts`
   `resolveProjectTrusted()` — `if (options.trustOverride)` treated `false` as
   "no override" because of the truthiness check. An explicit
   `--project-trust=false` then fell through to extension decisions, the saved
   trust store, `defaultProjectTrust` or an interactive prompt.

   Fix: test `options.trustOverride !== undefined` so an explicit `false`
   short-circuits with no prompt, no extension event and no consent write.

## End-to-end behaviour after the repair

`DefaultResourceLoader.reload({ resolveProjectTrust })` now runs:

1. `loadProjectTrustExtensions()` → `setProjectTrusted(false)` → `reload()` →
   only global/CLI resources; the trust resolver therefore receives a
   pre-trust extension set that contains no project extensions and observes
   `isProjectTrusted() === false` and global-only settings.
2. The resolver returns the decision; an explicit override returns immediately
   with its value (including `false`).
3. `setProjectTrusted(decision)` + `reload()` → for a trusted decision,
   `loadFromStorage` reads the project scope again, `deepMergeSettings` merges
   nested project values over inherited global ones, and project extensions are
   admitted; for an untrusted decision project settings stay `{}` and project
   resources stay out.

APIs are unchanged: no signatures, exports or call sites were modified.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` drives the real
`SettingsManager`, `DefaultResourceLoader` and `resolveProjectTrusted` through
`.prale-eval/subject.mjs` (only storage IO, package resolution, extension
loading and the trust UI are faked). It asserts:

- bootstrap extension set and package resolution are global/CLI only, with
  untrusted settings and inherited global nested values;
- a fresh bootstrap in an already-trusted process still starts from global
  configuration, then the trusted reload admits `project.ts` and merges nested
  project settings (`reserveTokens` overridden, `keepRecentTokens` inherited);
- explicit `false` wins over an approving extension and an available UI with no
  `extension-decision` event and no consent writes, explicit `true` wins too,
  and the loader end-to-end keeps project resources out for `override: false`;
- `SettingsManager.fromStorage(..., { projectTrusted: false })` ignores project
  settings, re-reads them on `setProjectTrusted(true)`/`reload()`, and drops
  them again when untrusted.

Each faulty baseline was re-introduced alone and the script failed with an
`AssertionError` (never an import error or crash) in every case:

- `resource-loader.ts` restoring `setProjectTrusted(true)` → bootstrap leaked
  the project extension set;
- `settings-manager.ts` restoring the no-op guard → bootstrap resolved with
  project settings;
- `project-trust.ts` restoring the truthiness check → explicit `false` was
  overridden by the approving extension.

The repository's own vitest suites could not be executed in this sandbox
because `node_modules` is not installed and dependency installation is out of
scope; the regression script above is dependency-free (Node 24 built-ins only).
