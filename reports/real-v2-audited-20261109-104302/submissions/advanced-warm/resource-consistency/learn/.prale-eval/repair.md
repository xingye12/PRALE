# Repair: untrusted startup leaks project configuration

## Incident summary

A process that was already trusted (for example, started once before in the same
project) began a fresh bootstrap and the project's `.pi` settings and resources
were visible/loaded **before** consent. In addition, an explicit `--project-trust=false`
style override was ignored whenever it was the value `false`.

Three independent defects broke one producer/consumer chain:

```
resource-loader (bootstrap)  ->  settings-manager (trust gate)  ->  project-trust (decision)
```

## Defects and fixes

### 1. `packages/coding-agent/src/core/resource-loader.ts` — bootstrap trusted the project

```diff
 async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
 	// Force untrusted project settings for the bootstrap pass. ...
-	this.settingsManager.setProjectTrusted(true);
+	this.settingsManager.setProjectTrusted(false);
 	await this.settingsManager.reload();
 	return this.loadCurrentExtensionSet({ includeInlineFactories: true });
 }
```

`loadProjectTrustExtensions` is the producer of the pre-consent extension set
that `reload()` passes to `resolveProjectTrust`. It forced trust **on** rather
than off, so the bootstrap pass re-read project settings and resolved project
extensions/packages. The `packageManager.resolve()` call inside that pass reads
`settingsManager.getProjectSettings()`, so project extension paths entered the
pre-trust set and were handed to the trust decision (and reused by
`loadFinalExtensionSet`). Forcing the untrusted state makes the bootstrap pass
read global settings plus temporary CLI extension sources only.

### 2. `packages/coding-agent/src/core/settings-manager.ts` — the trust gate was dead code

```diff
 private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
-	if (false) {
+	if (scope === "project" && !projectTrusted) {
 		return {};
 	}
```

`SettingsManager` already threaded `projectTrusted` from `fromStorage`/
`fromStorageWithPaths`, from `setProjectTrusted` and from `reload()` into
`loadFromStorage`, but the guard was disabled, so project JSON was always parsed
and merged. Reinstating the guard makes an untrusted `create`/`fromStorage`,
an untrusted `reload()` and `setProjectTrusted(false)` all yield
`getProjectSettings() === {}` while global settings (and their nested values)
stay loaded.

### 3. `packages/coding-agent/src/core/project-trust.ts` — explicit `false` override was lost

```diff
 export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
-	if (options.trustOverride) {
+	if (options.trustOverride !== undefined) {
 		return options.trustOverride;
 	}
```

The truthiness check treated `trustOverride: false` as "no override", so the
caller fell through to extension trust events, the stored trust decision, the
`defaultProjectTrust` policy and finally a UI prompt — the project became
trusted even though the user explicitly said no. Presence-based comparison
makes every explicit override decisive and silent (no project-trust extension
event, no prompt, no persisted consent), while `undefined` keeps the previous
decision flow intact.

## End-to-end boundary after the fix

1. `DefaultResourceLoader.reload({ resolveProjectTrust })` calls
   `loadProjectTrustExtensions()`, which marks the manager untrusted and
   reloads, so `packageManager.resolve()` sees only global settings — the
   pre-consent set contains global + CLI extensions, never project ones.
2. `resolveProjectTrusted` evaluates the explicit override first
   (`!== undefined`), so `false` wins immediately and silently.
3. `setProjectTrusted(<decision>)` plus `reload()` then either keep the gate
   closed (`projectSettings = {}`) or admit project settings, after which the
   final resolve/load pass adds project extensions on top of the preserved
   global and CLI resources and the nested global values (for example
   `compaction.keepRecentTokens`) inherited under project overrides
   (`compaction.reserveTokens`).

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (Node 24, run from the
workspace root) drives the real `resource-loader`, `settings-manager` and
`project-trust` modules through `.prale-eval/subject.mjs` with only storage,
package resolution, the extension loader and the UI faked. It asserts:

* bootstrap resolves/loads global + CLI extensions only, with the manager
  untrusted and `getProjectSettings() === {}`;
* a trusted reload admits project extensions and keeps nested inheritance
  (`reserveTokens` from project, `keepRecentTokens` from global) without
  touching global settings;
* `trustOverride: false` beats a stored `true` decision and an `always`
  policy without emitting a trust event, prompting or writing consent;
* `trustOverride: true` decides without prompting;
* `undefined` still honors a stored decision silently;
* `SettingsManager` alone: untrusted create/reload skips project settings,
  untrusted project writes still throw, `setProjectTrusted(true)` admits them,
  and dropping trust hides them again.

Cross-file mutation check: restoring each production file to its faulty
baseline **one at a time** makes the script fail with an assertion (never an
import error, crash or timeout):

| file restored to baseline | failing assertion |
| --- | --- |
| `resource-loader.ts` | `the pre-consent bootstrap pass must read global configuration only` |
| `settings-manager.ts` | `the pre-consent bootstrap pass must read global configuration only` |
| `project-trust.ts` | `an explicit false override short-circuits the extension trust decision` |

With all three repairs in place the script exits `0`. No real clock, randomness,
network or external services are used; async ordering is driven by awaited
promise fakes. Repository-level `vitest`/`tsc` runs were not used as evidence
because the workspace has no installed dependencies; the harness above needs
none. Temporary backup copies used for the mutation check lived under
`.prale-eval/` and were removed.
