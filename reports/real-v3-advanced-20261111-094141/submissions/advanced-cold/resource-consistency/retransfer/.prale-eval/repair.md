# Repair: revocation must clear cached resources and settings

Task: `advanced/resource-consistency/retransfer` — repository `earendil-works/pi`.

## Incident chain (producer → consumer)

```
project-trust.ts (policy)  ──resolveProjectTrusted()──▶  resource-loader.ts (reload)
        ▲                                                      │ setProjectTrusted(...)
        │                                                      ▼
ProjectTrustStore / extensions            settings-manager.ts (settings cache: projectTrusted + projectSettings)
                                                               │ isProjectTrusted() / getProjectSettings()
                                                               ▼
                                                     package-manager.ts resolve() ──▶ resolved resource set
```

Three defects broke that chain in the "ask / approve / revoke / reload" path:

1. **`packages/coding-agent/src/core/project-trust.ts:87` — missing UI became implicit consent.**
   After the explicit `always` / `never` policies and after the stored-decision lookup, the `ask`
   branch returned `true` when `projectTrustContext.hasUI` was false. A headless reload (print,
   json, rpc, or a reload during startup) with no stored decision therefore silently trusted the
   project. Fixed to deny (`return false`), matching the existing "prompt cancelled ⇒ `false`" rule
   later in the same function: no UI is no answer, and no answer is not consent.

2. **`packages/coding-agent/src/core/settings-manager.ts:524` — revocation kept the cached project configuration.**
   `setProjectTrusted(false)` reset the modified-field bookkeeping but reassigned
   `this.projectSettings = this.projectSettings`, so the merged `settings` view kept every
   project-local value after trust was withdrawn, and only a later disk reload could clear it.
   Fixed to `this.projectSettings = {}`, which drops project configuration immediately while the
   already-loaded `globalSettings` (and CLI overrides applied through `applyOverrides`) stay intact.

3. **`packages/coding-agent/src/core/resource-loader.ts:454` — the loader discarded the resolved decision.**
   `reload({ resolveProjectTrust })` first loads a bootstrap (untrusted) extension set, asks the
   consumer for a decision, and then called `setProjectTrusted(true)` unconditionally. The
   resolver's answer was thrown away, so a revoked project was re-trusted on the spot: project
   `settings`/`extensions`/`skills`/`prompts`/`themes` stayed in the next resolved resource set.
   Fixed to `setProjectTrusted(projectTrusted)`.

Each defect is on a different side of a module boundary (policy producer, settings-cache owner,
resource-set consumer), which is why the incident needed all three changes: fixing only the policy
still let the loader force trust; fixing only the loader still left project settings applied;
fixing only the settings cache still let headless startups approve themselves.

## Preserved behavior

* Stored decisions, `defaultProjectTrust: always|never`, `--project-trust` overrides, and extension
  `project_trust` handlers keep their precedence; only the unresolved headless `ask` case changed.
* Global and CLI resources are still resolved when a project is untrusted — the loader only drops
  project-scoped resources (`.pi/**`, project `.agents/skills`), never `agentDir` or CLI paths.
* `reload()` without `resolveProjectTrust` still performs no trust transfer at all: it reloads
  settings for the current `projectTrusted` state, so the existing trust state is retained.
* Writes to project settings while untrusted are still rejected; `SettingsManager` public API and
  all signatures are unchanged.

## Validation

`.prale-eval/regression.mjs` links the real modules through `.prale-eval/subject.mjs` graphs and
asserts cross-module behavior with uncaught `node:assert/strict` assertions:

* **Trust policy** (`project-trust.ts`): headless `ask` with no stored decision denies and persists
  nothing; stored approval/revocation, `always`/`never`, CLI override, `project_trust` extension
  results (approve/deny/remember/error) and interactive approve/cancel are all covered.
* **Settings transfer** (`settings-manager.ts`): approval applies project configuration;
  revocation discards cached project settings, falls back to global values (theme, compaction
  override) and keeps global settings; untrusted project writes still throw.
* **Resolved resource set** (`resource-loader.ts` + real `settings-manager.ts` + real
  `project-trust.ts`): bootstrap pre-trust set never contains project extensions, headless `ask`
  loads only global + CLI extensions, a stored approval adds the project extension and project
  settings, a stored revocation removes both again, and a resolver-less `reload()` keeps the
  revoked state.

Boundary fakes supply `ProjectTrustStore` persistence, the extension `project_trust` event bus,
package resolution, extension loading, theme/skill/prompt loaders, path helpers and `chalk`;
temporary inputs are created under `.prale-eval/tmp` and removed in a `finally` block.

Mutation check (performed locally, not shipped): restoring any one of the three files to its
faulty baseline makes the script exit non-zero with an `AssertionError` (no crash/import error),
specifically:

| reverted file | failing assertion |
| --- | --- |
| `project-trust.ts` | "a headless ask without a stored decision must deny access" |
| `settings-manager.ts` | "revocation must discard cached project settings" |
| `resource-loader.ts` | "headless ask without a decision must not load project extensions" |

Limitation: the workspace has no installed dependencies (`node_modules` absent), so `tsc` and the
repository's `vitest` suites cannot run here. Validation is therefore the required Node 24
`--experimental-vm-modules` script, which executes the real TypeScript sources after type stripping.
No network, credentials, timers or randomness are used as evidence.
