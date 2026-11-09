# Repair: session-only trust approval must not become persisted consent

## Faults found

The incident crossed three production modules. Each defect alone breaks the trust
lifecycle, and the combination made a session-only decision look permanent:

1. `packages/coding-agent/src/core/settings-manager.ts` — `setProjectTrusted` returned
   early when the requested trust differed from the current value
   (`if (this.projectTrusted !== trusted) return;`). The guard was inverted, so the
   trust flag never changed, project settings were never cleared on loss of trust, and
   were never re-read on regrant of trust.

2. `packages/coding-agent/src/core/resource-loader.ts` — `reload({ resolveProjectTrust })`
   loaded the untrusted bootstrap extension set but then hard-coded
   `const projectTrusted = false;`, never awaiting the injected resolver. The resolver
   therefore ran zero times, the final load stayed untrusted, and project resources
   could not appear after approval.

3. `packages/coding-agent/src/core/project-trust.ts` — the extension decision branch
   persisted with `if (result.remember !== undefined)`. An extension returning only
   `{ trusted: "yes" }` (or `remember: false`) silently wrote consent to the trust
   store, turning a session-only grant/denial into a permanent one.

## Cross-module repair

- `setProjectTrusted` now returns only when the requested trust equals the current
  trust (`===`). On change it clears modified project bookkeeping; losing trust empties
  project settings and re-merges global settings; gaining trust re-reads project
  settings from storage and recomputes the merged view.
- `reload` captures the optional resolver once (`const resolveProjectTrust =
  options?.resolveProjectTrust`), keeps the pre-trust bootstrap (`loadProjectTrustExtensions`
  forces `setProjectTrusted(false)` and reloads so only user/CLI extensions load), then
  awaits `resolveProjectTrust({ extensionsResult: preTrustExtensions })` exactly once
  and applies the returned boolean before the final `settingsManager.reload()` and
  resource resolution. The bootstrap result is reused by `loadFinalExtensionSet`, so
  already-loaded user/CLI extensions are not executed twice.
- `resolveProjectTrusted` persists only when `result.remember === true`. Approvals and
  denials both return their decision immediately; without an explicit `remember` the
  grant is session-scoped and the trust store is untouched. The existing prompt path
  keeps its own semantics (only options with non-empty `updates` persist), so
  "Trust/Do not trust (this session only)" still writes nothing.

No public API signatures changed: `ResourceLoaderReloadOptions`, `SettingsManager.setProjectTrusted`,
and `resolveProjectTrusted` keep their shapes.

## Validation

`.prale-eval/regression.mjs` links the real submitted modules through
`.prale-eval/subject.mjs` (only storage, extension event delivery, UI, package
resolution and extension loading are faked) and asserts:

- the bootstrap resource/extension resolution sees `isProjectTrusted() === false`,
  global settings only, and user/CLI extensions only;
- the resolver starts exactly once, after bootstrap completes (a promise gate holds it
  open while bootstrap state is inspected), and is never invoked again for the final
  load;
- an approval reloads project settings/extensions and reuses the preloaded set;
- a denial leaves the project untrusted and unloaded;
- extension `{ trusted: "yes" }`, `{ trusted: "yes", remember: false }` and
  `{ trusted: "no", remember: false }` grant/deny for the session with zero trust-store
  writes, while `remember: true` persists `[cwd, true]` / `[cwd, false]`;
- `SettingsManager.setProjectTrusted(false/true)` clears/reloads project settings
  immediately without touching global settings or storage;
- global and project settings storage payloads are byte-identical after every reload
  (no global configuration mutation).

Ordering is controlled only with promises (microtask draining and an explicit gate);
no timers, randomness, network or external services are used. The script creates no
on-disk fixtures, so there is nothing to clean up.

Each original single-file baseline was restored temporarily during development:
reverting `project-trust.ts` fails the consent assertion, reverting
`resource-loader.ts` fails the "resolver runs exactly once" assertion, and reverting
`settings-manager.ts` fails the untrusted-bootstrap assertion — all as uncaught
`AssertionError`s, not crashes or timeouts.

`vitest`/`node_modules` is not installed in this workspace, so the repository's
TypeScript test suite could not be executed; the mandated Node 24 regression script is
the validation evidence.
