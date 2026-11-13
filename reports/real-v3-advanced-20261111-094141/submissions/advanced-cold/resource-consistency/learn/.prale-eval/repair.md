# Repair: untrusted startup leaks project configuration

## Incident, traced across module boundaries

Startup never trusts a project before consent, so three cooperating layers have to
agree:

1. `SettingsManager` decides whether `.pi/settings.json` may be read at all
   (`packages/coding-agent/src/core/settings-manager.ts`).
2. `DefaultResourceLoader.loadProjectTrustExtensions()` performs the pre-consent
   bootstrap pass and must keep project-local extensions/packages out while still
   loading global/user resources and temporary CLI (`--extension`/`-e`) resources
   (`packages/coding-agent/src/core/resource-loader.ts`).
3. `resolveProjectTrusted()` turns `--approve` / `--no-approve` (i.e.
   `projectTrustOverride`) plus saved trust into the boolean that then re-gates
   both of the above (`packages/coding-agent/src/core/project-trust.ts`).

Three independent faults broke that chain.

### 1. `settings-manager.ts` — the trust gate in the loader was dead code

```ts
private static loadFromStorage(storage, scope, projectTrusted = true) {
-    if (false) {              // gate removed: project scope was always parsed
+    if (scope === "project" && !projectTrusted) {
         return {};
     }
```

`loadFromStorage` still *received* `projectTrusted` (from
`fromStorageWithPaths`, `setProjectTrusted` and `reload`) but ignored it, so
`SettingsManager.create(cwd, agentDir, { projectTrusted: false })`,
`setProjectTrusted(false)` and `reload()` all still parsed and merged
`cwd/.pi/settings.json`. Every consumer — `getProjectSettings()`, `getTheme()`,
the nested `getCompactionSettings()` merge, and `PackageManager.resolve()` via
`isProjectTrusted()` — therefore saw project configuration before consent.

### 2. `resource-loader.ts` — the bootstrap pass opted *into* trust

```ts
async loadProjectTrustExtensions() {
-    this.settingsManager.setProjectTrusted(true);   // trusted a project before asking
+    this.settingsManager.setProjectTrusted(false);
     await this.settingsManager.reload();
     return this.loadCurrentExtensionSet({ includeInlineFactories: true });
}
```

The comment above the line already documented the intent ("Force untrusted
project settings for the bootstrap pass"), but the call did the opposite. Because
the bootstrap pass is invoked from `reload({ resolveProjectTrust })` *before*
`resolveProjectTrust()` runs, a project that had been trusted earlier in the
process (or whose settings simply existed) handed its `.pi/extensions`,
`.pi/skills`, `.pi/prompts` and `.pi/themes` to the trust callback — and to the
`project_trust` extension hook — before any consent decision existed.

### 3. `project-trust.ts` — `false` was indistinguishable from "no override"

```ts
export async function resolveProjectTrusted(options) {
-    if (options.trustOverride) {                    // `false` fell through
+    if (options.trustOverride !== undefined) {
         return options.trustOverride;
     }
```

With an explicit `--no-approve`, the truthiness test skipped the early return, so
resolution continued to the extension hook, the saved trust store, the
`defaultProjectTrust: "always"` shortcut and finally the interactive prompt — an
explicit denial lost to a saved approval, and the user was prompted anyway.

## Why the fix is the whole boundary

With all three repaired, the flow is:

* `main.ts` builds `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`
  (global configuration only) and creates the runtime with `projectTrusted: false`
  when trust must be resolved.
* `ResourceLoader.reload({ resolveProjectTrust })` → `loadProjectTrustExtensions()`
  forces untrusted settings and loads only global/user + temporary CLI extensions.
  The package manager is consulted while `isProjectTrusted() === false`, so no
  auto-discovered project resources appear.
* `resolveProjectTrusted()` returns the explicit override when one exists (both
  `true` and `false`, without prompting or writing the trust store) and otherwise
  uses extension hook → saved decision → `defaultProjectTrust` → prompt.
* `setProjectTrusted(true)` + `settingsManager.reload()` re-read `.pi/settings.json`
  through the now-effective gate, and the same `reload()` re-resolves resources so
  project extensions are admitted, with the pre-trust extensions reused from the
  cache (`loadFinalExtensionSet`) instead of being loaded twice.
* Global/CLI resources are untouched in every state, and `deepMergeSettings` keeps
  merging nested objects (global `compaction.enabled`/`keepRecentTokens` survive a
  project `compaction.reserveTokens`).

## Regression test (`.prale-eval/regression.mjs`)

The script links the three real modules in one VM graph
(`createGraph(root, [resource-loader.ts, settings-manager.ts, project-trust.ts], …)`)
and supplies boundary fakes only at the edges:

* `DefaultPackageManager` — mirrors the real gating rule: project `.pi`
  resources are returned only while `settingsManager.isProjectTrusted()` is true;
  user/global resources and temporary CLI sources are always returned.
* `loadExtensionsCached` / `createExtensionRuntime` / `loadExtensionFromFactory` —
  extension loading boundary (paths in, extension records out).
* `loadSkills` / `loadPromptTemplates` / `loadThemeFromPath` / `findGitPaths` /
  `createEventBus` / `resetTimings` / `createSourceInfo` /
  `emitProjectTrustEvent` / `getProjectTrustOptions` /
  `hasTrustRequiringProjectResources` / `chalk` / `config` / `utils/paths`.
* `SettingsStorage` — in-memory scope map (the subject is the trust gate, not
  file I/O), plus the trust store and prompt UI at the `resolveProjectTrusted`
  boundary.

Assertions (all `node:assert/strict`, no timers, no randomness, no network):

1. `SettingsManager.fromStorage(..., { projectTrusted: false })` exposes global
   settings and `{}` project settings; `setProjectTrusted(true)` then admits the
   project settings with nested inheritance intact; `reload()` respects the
   current trust both ways.
2. `resolveProjectTrusted` honors `trustOverride: false` against a saved approval
   and `defaultProjectTrust: "always"` without calling `ui.select` or writing the
   trust store; `trustOverride: true` beats a saved denial; without an override the
   saved decision/default still applies and headless sessions stay untrusted.
3. The bootstrap pass returns only `[cli, global]` extensions, leaves the settings
   manager untrusted, and never asks the package manager for trusted resources.
4. A trusted `reload()` decides trust from `[cli, global]` only, then admits the
   project extension, project settings and the nested merge.
5. An explicit `false` override routed through the real `resolveProjectTrusted`
   keeps the project extension and project settings out even with a saved
   approval, and prompts nobody.
6. A saved approval still admits project resources without prompting (behavior
   preserved).

Local fixture files are created under `.prale-eval/fixture/` and removed in a
`finally` block; nothing outside the workspace is touched.

## Verification performed

* `node --experimental-vm-modules .prale-eval/regression.mjs` → passes (6/6
  scenarios).
* Mutation check: each production file was restored alone to its faulty baseline
  and the script was re-run. All three produced an `AssertionError` (a real
  assertion failure, not a crash/import error):
  * `settings-manager.ts` (`if (false)`) → "project settings must not be read before consent"
  * `resource-loader.ts` (`setProjectTrusted(true)`) → "the pre-consent bootstrap must load only global and temporary CLI extensions"
  * `project-trust.ts` (`if (options.trustOverride)`) → "an explicit false override must win over saved trust"
* Limitation: the repository's own suites (`vitest`, `tsgo`, `scripts/check-*.mjs`)
  could not be run because this workspace has no installed dependencies
  (`node_modules` is absent: `ERR_MODULE_NOT_FOUND: Cannot find package 'typescript'`).
  No dependency was installed; the TypeScript sources were instead loaded through
  Node 24's `stripTypeScriptTypes` inside `subject.mjs`, which also type-strips the
  edited files successfully.
