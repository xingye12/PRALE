# Repair: revocation must clear cached resources and settings

Task ID: `advanced/resource-consistency/retransfer` · Repository: `earendil-works/pi`

## Incident summary

Three independent defects sat on one producer/consumer chain. A trust decision is produced by
`project-trust.ts`, stored into `SettingsManager` by `resource-loader.ts`, and consumed by the
settings getters and the package/resource resolution that runs after the decision. Each link
silently converted "no decision" or "trust revoked" into "trusted", so project configuration and
project extensions survived a headless run and a revocation.

## Cross-module flow

```
DefaultResourceLoader.reload({ resolveProjectTrust })
  └─ loadProjectTrustExtensions()      settingsManager.setProjectTrusted(false) + reload()
       └─ loadCurrentExtensionSet()    -> packageManager.resolve()  (global/CLI extensions only)
  └─ resolveProjectTrust(...)          -> project-trust.ts: resolveProjectTrusted()
       └─ returns trusted|not trusted (stored decision / policy / UI / extension event)
  └─ settingsManager.setProjectTrusted(<decision>)      <-- link 2 (resource-loader)
  └─ settingsManager.reload()          -> project scope loaded only while trusted
       └─ packageManager.resolve()     -> consumes settings.getGlobalSettings()/getProjectSettings()
  └─ loadFinalExtensionSet(...)        -> final resolved resource set
```

## Defects and fixes

### 1. `packages/coding-agent/src/core/project-trust.ts` — missing UI became implicit consent

After the extension `project_trust` event and the stored-decision lookup, the `"ask"` policy could
not be answered without a UI. The headless branch returned `true`, so a print/json/rpc run with no
stored decision was granted trust without any user ever saying yes.

Fix: return `false` when `projectTrustContext.hasUI` is false, i.e. an unanswerable prompt is a
denial. Stored decisions (`trustStore.get`), explicit overrides, `always`/`never` policies and the
interactive prompt path are unchanged.

### 2. `packages/coding-agent/src/core/settings-manager.ts` — revocation kept cached project settings

`setProjectTrusted(false)` cleared the modified-field bookkeeping but then executed
`this.projectSettings = this.projectSettings;` — a no-op. Every consumer (`getDefaultModel`,
`getProjectSettings`, `getCompaction*`, and `package-manager`'s project-scope filtering) kept serving
the configuration loaded while the project was trusted until some later reload happened to overwrite
it.

Fix: assign `{}`, so the merged view immediately falls back to global settings. The stored project
settings file is untouched (only the in-memory cache is discarded), and the existing load-error and
re-trust paths are preserved.

### 3. `packages/coding-agent/src/core/resource-loader.ts` — the resolved decision was ignored

`reload()` computed `const projectTrusted = await options.resolveProjectTrust(...)` and then
unconditionally called `this.settingsManager.setProjectTrusted(true)`. The resolver's `false` was
discarded, so the subsequent `reload()` + `packageManager.resolve()` produced project settings and
project extensions even for a denial or a revocation. This also masked defect 1 at the resource
layer: the resolver said no, the loader applied yes.

Fix: apply the resolved value — `this.settingsManager.setProjectTrusted(projectTrusted)`. The
bootstrap pass still forces `false` while resolving (project resources never load before the
decision), and `reload()` without a resolver still never touches trust, so an existing decision is
retained.

## Validation

Command (run from the workspace root):

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

`.prale-eval/regression.mjs` loads the submitted modules through the read-only
`.prale-eval/subject.mjs` graph (only settings storage, package manager, extension loader, trust
store and UI prompts are faked) and asserts observable behaviour across the module boundaries:

1. Headless reload, no stored decision, `ask` policy → resolver returns `false`, project stays
   untrusted, project settings are `{}`, merged settings fall back to the global model/compaction
   values, the resolved set is CLI + global only, the pre-trust pass never loads the project
   extension, and no trust decision is written to the store.
2. Stored decisions (`false`/`true`) are still honoured and an interactive approval still grants
   trust.
3. A previous approval loads project settings and the project extension; `reload()` without a
   resolver retains trust, settings and project extensions and never re-runs the decision.
4. Revocation: project settings cache cleared, global model/compaction restored, global extension
   configuration intact, project extension absent from the next resolved set, final `resolve` event
   reports `(trusted=false, model=global-model)`, and the stored project settings file is unchanged.
5. `SettingsManager.setProjectTrusted(false)` alone (no reload) clears cached project settings for
   every getter immediately, and a later resolver-less reload does not resurrect them.

The same script was run with each source file restored individually to its faulty baseline; all
three mutations exit non-zero through a real `AssertionError` on a behavioural assertion (no
import error, crash or timeout):

| Restored faulty file | Observed failure |
| --- | --- |
| `project-trust.ts` (`return true` without UI) | `headless ask-policy resolution without a stored decision must deny` (`true !== false`) |
| `settings-manager.ts` (`this.projectSettings = this.projectSettings`) | `setProjectTrusted(false) must clear cached project settings` |
| `resource-loader.ts` (`setProjectTrusted(true)`) | `headless denial must leave the project untrusted` (`true !== false`) |

Repair state: exit code 0.

Limitations: the repository's vitest suites (`packages/coding-agent/test/settings-manager.test.ts`,
`test/resource-loader.test.ts`) were not run because `node_modules` is not installed in this
workspace; the Node 24 based regression script above is the validation evidence. Test inputs are
created under `.prale-eval/` only and removed on exit; no timers, randomness or external services
are used.
