# Repair: revocation must clear cached resources and settings

## Incident chain (producer → consumer)

1. **Producer — `packages/coding-agent/src/core/project-trust.ts` (`resolveProjectTrusted`)**
   Headless modes (print/json/rpc, no `~/...` TTY) still call the resolver with
   `projectTrustContext.hasUI === false`. The faulty fallback returned `true` when the
   `ask` policy needed a prompt but no UI could show it, i.e. missing UI was treated as
   implicit consent. The documented contract (`docs/security.md`, "Project trust without
   an interactive prompt") is that `"ask"` (and `"never"`) **skip** protected resources
   when no override, extension decision or saved decision applies.
   **Fix:** return `false` instead of `true`.

2. **Consumer — `packages/coding-agent/src/core/settings-manager.ts` (`setProjectTrusted`)**
   Revocation (`setProjectTrusted(false)`) contained a self-assignment
   `this.projectSettings = this.projectSettings`, so the already-cached project settings
   survived the trust change and were re-merged over the global settings. That kept
   project configuration (theme/model/compaction/packages/extension paths) applied after
   trust was revoked.
   **Fix:** clear the cached project scope (`this.projectSettings = {}`) before re-merging,
   so only global settings remain. Global settings, modification tracking and the
   untrusted-write guard are untouched, and `setProjectTrusted(true)` still reloads
   project settings from storage.

3. **Consumer — `packages/coding-agent/src/core/resource-loader.ts` (`reload`)**
   After the trust resolver returned, `reload()` unconditionally called
   `this.settingsManager.setProjectTrusted(true)`, discarding the resolver's answer. A
   revocation could therefore never take effect: the subsequent
   `settingsManager.reload()` re-read project settings and `packageManager.resolve()`
   re-added project extensions, while the follow-up reload (which should "preserve the
   existing trust state") still ran against a forced-trusted manager.
   **Fix:** apply the resolved value (`setProjectTrusted(projectTrusted)`). The call stays
   inside the `options?.resolveProjectTrust` branch, so a reload **without** a resolver
   keeps the current trust state instead of resetting it.

## Cross-module behaviour after the fix

- Headless reload, `ask` policy, no stored decision, no CLI override, no extension
  decision → trust denied; no prompt is attempted and no decision is persisted.
- Revocation through `reload({ resolveProjectTrust: () => false })` immediately reaches
  the settings manager: cached project configuration is dropped and only global settings
  apply.
- The next resolved resource set contains global user extensions and CLI extensions, but
  no project extensions; the pre-trust bootstrap pass likewise offers only global/CLI
  extensions to the trust resolver.
- `reload()` without a resolver neither grants nor revokes trust.
- Approval through the resolver still loads project configuration and project extensions.

## Regression coverage (`regression.mjs`)

The script links the real `project-trust.ts`, `settings-manager.ts`, and
`resource-loader.ts` modules through `.prale-eval/subject.mjs` with boundary fakes for
fs paths, the package manager, and the extension loader. It asserts, across the
producer/consumer boundary:

- headless `ask` denies (and `always`/`never`, stored decisions, overrides, extension
  `project_trust` decisions, and interactive selections still behave correctly);
- `setProjectTrusted(false)` discards cached project settings while keeping global ones,
  and re-trusting restores project settings;
- a trusted reload → revoke reload → plain reload sequence keeps project extensions out
  of `getExtensions()` while preserving global and CLI extensions, keeps
  `SettingsManager.getProjectSettings()` empty, and preserves the revoked state on a
  resolver-less reload.

Verified: the script passes on the repair and fails with an assertion (not a crash) when
each of the three files is individually restored to its faulty baseline.
