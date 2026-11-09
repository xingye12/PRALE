# Cross-module repair: trust decision, settings precedence, resource assembly

Three production modules disagreed about project trust, so a remembered denial
could be upgraded to trust and an approved reload could still behave untrusted.
Each fault below was found by tracing the incident end to end through
`resolveProjectTrusted` -> `SettingsManager` -> `DefaultResourceLoader`.

## 1. `packages/coding-agent/src/core/project-trust.ts` — stored denial was falsy

`resolveProjectTrusted` consulted the trust store with `if (decision)`. A stored
`false` denial is falsy, so the denial was treated as "no decision" and execution
fell through to `defaultProjectTrust`, where `"always"` (allow by default)
returned `true`. A stored boolean decision is authoritative in both directions;
only a missing/`null` entry may fall through to the configured default policy.

Repair: gate on the value's type (`typeof decision === "boolean"`) instead of its
truthiness, preserving the existing API and the `boolean | null` trust-store
contract.

## 2. `packages/coding-agent/src/core/settings-manager.ts` — merge arguments reversed

`deepMergeSettings(base, overrides)` called
`deepMergeObjects(overrides, base)`, swapping the project/override layer into the
base position. Global values therefore won instead of project values, so a
trusted project could never override `defaultModel`. Because the recursion in
`deepMergeObjects` was still correct, nested keys merely present in global
configuration (`compaction.keepRecentTokens`) survived but nested project
overrides (`compaction.reserveTokens`) were discarded too.

Repair: call `deepMergeObjects(base, overrides)` so project/overrides win and
untouched nested global defaults still merge through. The pre-existing trust
gating in `loadFromStorage`/`setProjectTrusted`/`reload` is untouched: project
values participate only while `projectTrusted` is true.

## 3. `packages/coding-agent/src/core/resource-loader.ts` — approved decision discarded

`DefaultResourceLoader.reload` deliberately runs a bootstrap pass with project
trust forced off, then resolves trust through `options.resolveProjectTrust`.
It captured the resolved boolean but immediately called
`this.settingsManager.setProjectTrusted(false)`, so the final resolution pass
always ran untrusted: the project `settings.json` stayed empty and project
extensions never reached `packageManager.resolve()`. Accepted (approved)
reloads silently lost project configuration.

Repair: propagate the resolved value with
`this.settingsManager.setProjectTrusted(projectTrusted)` before the existing
`settingsManager.reload()`; `SettingsManager.reload()` then reloads the project
scope only for the accepted trust state, matching `package-manager-cli.ts`.

## End-to-end behavior now

1. Bootstrap pass forces untrusted settings, so project extensions/config are
   excluded while user/global and CLI resources still load.
2. `resolveProjectTrusted` returns the extension decision, otherwise the stored
   boolean (allow or denial), otherwise the default policy/prompt.
3. `SettingsManager.setProjectTrusted(trusted)` + `reload()` load project
   settings only when trusted; `deepMergeSettings` applies project values over
   global values while preserving untouched nested global defaults.
4. The final pass resolves packages/extensions from those settings, so the
   approved decision reaches final resource resolution and a denial keeps
   project resources out.

## Regression coverage (`.prale-eval/regression.mjs`)

The script imports the read-only `.prale-eval/subject.mjs` helper, which links the
real submitted `project-trust.ts`, `settings-manager.ts` and
`resource-loader.ts`; only storage, extension-loading and UI/provider
boundaries are deterministic fakes. Nine scenarios assert:

- a stored denial overrides `always`, and a stored allow overrides `never`;
- an absent decision still falls through to the default policy;
- project `defaultModel` wins and `compaction` merges per key
  (`reserveTokens: 4096` from project, `keepRecentTokens: 2000` from global);
- withdrawing trust drops project settings and restores global values, and
  re-trusting restores the project values;
- extension approval, stored allow and interactive "approve once" all make the
  project extension and project model reach final resolution, while the
  bootstrap resolution stays global-only;
- a stored denial keeps the project extension out of final resolution and never
  resets the settings trust state to trusted.

Validation evidence:

- Repaired tree: `node --experimental-vm-modules .prale-eval/regression.mjs`
  passes (`exit 0`).
- Restoring only `project-trust.ts` to its baseline fails with
  `a stored denial must override an allow-by-default policy`.
- Restoring only `settings-manager.ts` fails with
  `project values must win while trusted`.
- Restoring only `resource-loader.ts` fails with
  `an approved decision must make project extensions reach final resource
  resolution`.
- Each mutation check produced a normal uncaught `assert` failure (no import
  error, crash or timeout), and the fixed files were restored byte-for-byte.

Limitation: `node_modules` is not installed in this workspace, so the
repository's optional TypeScript/vitest toolchain could not be run. The
regression uses only the Node 24 standard library and creates no persistent test
inputs, so manual validation stays inside the workspace.
