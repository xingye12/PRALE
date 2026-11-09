# Repair: revocation must clear cached resources and settings

Task: `advanced/resource-consistency/retransfer` — repository `earendil-works/pi`.

## Incident summary

A headless (`hasUI: false`) reload with no stored decision and `defaultProjectTrust: "ask"`
was granted project trust instead of being denied, and revoking a previous approval did not
remove project configuration/extensions from the next resolved resource set. Global and CLI
resources had to survive, a reload without a resolver had to retain the current trust state,
and a missing UI must never be read as implicit consent.

## Faulty production code

Three cooperating modules each contributed a defect; all three are needed to reproduce the
incident, and each one alone re-introduces it.

### 1. `packages/coding-agent/src/core/project-trust.ts` — missing UI treated as consent

`resolveProjectTrusted()` reached the "ask" branch with `hasUI: false` and returned `true`:

```ts
if (!options.projectTrustContext.hasUI) {
    return true;   // headless ask policy silently approved the project
}
```

`packages/coding-agent/docs/security.md` ("Project trust without an interactive prompt")
requires `defaultProjectTrust: "ask"` or `"never"` to skip protected project resources when no
prompt can be shown. The branch now returns `false`; `"always"`, `"never"`, saved decisions,
CLI overrides and extension `project_trust` decisions are untouched, so the documented
precedence order is preserved and existing APIs are unchanged.

### 2. `packages/coding-agent/src/core/resource-loader.ts` — resolved decision discarded

`DefaultResourceLoader.reload()` obtained the decision from the `resolveProjectTrust` callback
and then threw it away:

```ts
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(true);   // always approved
```

That forced approval after a denial, so `SettingsManager.reload()` re-read project
`settings.json`, `packageManager.resolve()` contributed project extensions, and the resolved
extension set contained `project.ts` even though trust was revoked. The loader now applies the
resolved value — `this.settingsManager.setProjectTrusted(projectTrusted)` — so a denial keeps
project settings unloaded and project extensions out of the merged resource set, while the
untrusted bootstrap pass (`loadProjectTrustExtensions`, which already forces
`setProjectTrusted(false)`) keeps global and temporary CLI extensions loadable for the
`project_trust` event.

### 3. `packages/coding-agent/src/core/settings-manager.ts` — stale project settings on revoke

`SettingsManager.setProjectTrusted(false)` contained a self-assignment:

```ts
if (!trusted) {
    this.projectSettings = this.projectSettings;   // no-op: cached project config survived
    this.projectSettingsLoadError = null;
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
    return;
}
```

Until the next `reload()`, `getProjectSettings()`, `getDefaultModel()`, `getCompactionReserveTokens()`
and every other merged-settings reader still saw project values after trust had been revoked,
and extensions/consumers that resolve resources between the revocation and the next reload saw
project configuration. It now assigns `{}` before recomputing the merged settings, so the
revocation is immediately effective, project setting writes stay rejected
(`assertProjectTrustedForWrite`), and global settings are preserved by the merge.

## Cross-module behavior after the repair

For a headless reload with the `ask` policy and no stored decision:

1. `reload()` → `loadProjectTrustExtensions()` forces the settings manager untrusted and loads
   the bootstrap set (global + CLI extensions only).
2. `resolveProjectTrusted()` sees no CLI override, no extension decision and no stored decision,
   applies the `ask` default and denies because there is no UI.
3. `reload()` applies that denial to the settings manager, then re-resolves: project settings
   are `{}`, `packageManager.resolve()` contributes no project extensions, and the final set is
   global + CLI.

After an approval followed by a revocation (stored decision, CLI `--no-approve`, or a direct
`setProjectTrusted(false)`), the cached project settings are cleared immediately and the next
resolved resource set contains only global and CLI extensions. A `reload()` with no
`resolveProjectTrust` option never re-runs the bootstrap pass, so it retains the existing trust
state (true or false) instead of falling back to a default.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (from the workspace root) loads the
submitted production modules through `.prale-eval/subject.mjs` and asserts the behavior above;
the resource loader, settings manager and trust resolver all run for real, with only settings
storage, package resolution, extension loading and the UI stubbed.

Scenarios covered:

- headless + `ask` + no stored decision → trust denied, only `cli.ts`/`global.ts` resolved,
  `getProjectSettings()` empty, `getDefaultModel()` falls back to `global-model`, no trust
  decision persisted;
- stored approval → project extension and project settings present; `loader.reload()` without a
  resolver keeps the project trusted;
- approval then stored denial → project extension disappears, cached project settings cleared,
  global settings preserved, and the bootstrap set handed to the resolver already excludes it;
- CLI-style denial (`override: false`) after approval → same revocation semantics;
- immediate `setProjectTrusted(false)` → cached project settings cleared and merged settings
  fall back to global values, project writes rejected, next resolver-free reload keeps the
  revocation;
- documented non-ask paths still work: `always` (headless) loads project resources, `never`
  denies, interactive approval is honoured without persisting a decision.

Mutation check (performed locally, not part of the committed workspace): restoring
`project-trust.ts`, `settings-manager.ts` or `resource-loader.ts` one at a time to its faulty
baseline makes the script exit non-zero with an `AssertionError` (never an import error,
crash or timeout) — e.g. "headless ask policy must deny project trust", "revoking trust must
immediately clear cached project settings", and the denial scenarios for the loader.

Limitation: the repository's `vitest` suites (`packages/coding-agent/test/*`,
`npm run test --workspaces`) and `tsc` could not be run because dependency installation is not
available in this environment (`node_modules` is absent and installing dependencies is out of
scope). The regression script therefore uses only Node 24 built-ins plus the read-only
`.prale-eval/subject.mjs` helper. It creates no temporary files (settings storage is in-memory
and the extension/package/UI boundaries are faked), so nothing needed to be cleaned up.
