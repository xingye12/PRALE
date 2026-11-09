# Repair: session-only approval must not become permanent consent

## Symptom

The project-trust flow had three independent regressions along one producer/consumer
chain:

1. `resource-loader.ts` — after the intentionally untrusted bootstrap pass it never
   asked the trust resolver and forced `projectTrusted = false`. A stored approval,
   an extension decision, `--approve`, or the interactive prompt could therefore never
   grant project access, and the bootstrap extension set was never handed to the
   resolver, so `project_trust` handlers could not run at all.
2. `settings-manager.ts` — `setProjectTrusted` returned early when the requested state
   *differed* from the current one, so trust transitions were silently dropped:
   project settings were never cleared when trust was revoked and never loaded when
   trust was granted. That also weakened the bootstrap pass, which relies on
   `setProjectTrusted(false)` to strip project settings before loading user/global
   extensions.
3. `project-trust.ts` — an extension `project_trust` result was persisted whenever
   `remember` was not `undefined`, i.e. an explicit `remember: false` still wrote a
   permanent decision into the trust store.

## Fix

```diff
# core/resource-loader.ts (reload)
- const projectTrusted = false;
+ const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
  this.settingsManager.setProjectTrusted(projectTrusted);
```

The loader still performs the untrusted bootstrap first (`loadProjectTrustExtensions`
forces `setProjectTrusted(false)` + reload, so only user/global and temporary CLI
extensions load). It then invokes the resolver exactly once with that bootstrap
result, applies the returned decision to `SettingsManager`, and the following
`settingsManager.reload()` re-reads project settings for the new trust state.

```diff
# core/settings-manager.ts (setProjectTrusted)
- if (this.projectTrusted !== trusted) {
+ if (this.projectTrusted === trusted) {
    return;
  }
```

Only a genuine state change is skipped now; any real change clears/loads
`projectSettings` from storage and recomputes the merged view. Writes to project
settings remain guarded by `assertProjectTrustedForWrite`.

```diff
# core/project-trust.ts (extension decision)
- if (result.remember !== undefined) {
+ if (result.remember === true) {
    options.trustStore.set(options.cwd, trusted);
  }
```

`remember` must be explicitly `true` to persist consent. Both approval
(`trusted: "yes"`) and denial (`trusted: "no"`) still return their decision for the
current session without touching the trust store; the session-only built-in prompt
option already has `updates: []`, so it never persists anything either. No code path
writes global settings.

## Cross-module behavior asserted by `.prale-eval/regression.mjs`

`createResourcePipeline` links the real `resource-loader`, `settings-manager` and
`project-trust` modules (with settings storage in memory) so the whole chain runs:

- untrusted bootstrap: first extension scan sees `trusted: false` and the global
  `defaultModel`, and loads only `cli.ts` + `global.ts` (no project extension);
- resolver runs exactly once per reload; after approval `setProjectTrusted(true)`
  really reloads project settings (`defaultModel: "project-model"`, project
  extensions enabled) and the project extension is added to the final set;
- denial keeps the project extension and project settings out while global settings
  survive;
- the resolver receives the bootstrap extension set, so extension decisions drive
  the loader;
- session-only prompt approval grants access but records no consent write;
- extension `trusted: "yes"`/`"no"` persist nothing without `remember`, nothing with
  `remember: false`, and exactly one `[cwd, true|false]` write with `remember: true`;
- global configuration (both the `getGlobalSettings()` view and the stored global
  JSON) is unchanged by every session-only decision.

Restoring any single listed file to its faulty baseline makes the script fail with an
assertion error (not an import error or timeout), so each regression is independently
detected.
