# Repair: remembered denial and configuration precedence disagree

Task: `advanced/resource-consistency/transfer` (repository `earendil-works/pi`, mode `repair`).

The incident was three independent defects along one producer → consumer flow:

```
extension hook / trust store / policy  ->  resolveProjectTrusted()      (project-trust.ts)
        accepted or denied decision    ->  ResourceLoader.reload()      (resource-loader.ts)
        settings for that trust state  ->  SettingsManager merge        (settings-manager.ts)
        final resources                ->  PackageManager.resolve()/loader result
```

## 1. `packages/coding-agent/src/core/project-trust.ts` — a stored boolean was treated as "absent"

Before: `const decision = options.trustStore.get(options.cwd); if (decision) { return decision; }`

`ProjectTrustStore.get()` returns `boolean | null`. A remembered **denial** (`false`) is falsy, so
it skipped the authoritative branch and fell through to `defaultProjectTrust` — with the
allow-by-default policy (`"always"`) a denied folder silently became trusted. This is exactly the
reported "stored denial falls through to an allow-by-default policy".

After: only a genuinely missing entry falls through.

```ts
// A remembered decision is authoritative, including a remembered denial:
// only a missing entry (null/undefined) falls through to the default policy.
const decision = options.trustStore.get(options.cwd);
if (decision === true || decision === false) {
	return decision;
}
```

Precedence is otherwise untouched: `trustOverride` first, then trust-requiring-resource check,
then the awaited extension `project_trust` decision, then the store, then the policy, then the
prompt (no UI ⇒ deny). A stored denial also no longer reaches the prompt.

## 2. `packages/coding-agent/src/core/settings-manager.ts` — merge direction was reversed

Before: `deepMergeSettings(base, overrides)` called `deepMergeObjects(overrides, base)`, i.e. the
**base** (global) document was layered last and won every conflict. That inverted the documented
contract ("project/overrides take precedence") for every caller: the constructor, `reload()`,
`setProjectTrusted()`, `save()`, `saveProjectSettings()` and `applyOverrides()`. Nested objects
were merged in the wrong direction as well, so a project `compaction.reserveTokens` was discarded
and a session override could not win either — "accepted reloads lose project configuration".

After: `deepMergeObjects(base, overrides)` — base first, overrides last, recursion keeps nested
global defaults that the project does not mention. No signature or caller changed.

## 3. `packages/coding-agent/src/core/resource-loader.ts` — the resolved decision never reached assembly

Before, in `DefaultResourceLoader.reload()`:

```ts
preTrustExtensions = await this.loadProjectTrustExtensions();
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(false);   // decision ignored
```

The bootstrap pass (`loadProjectTrustExtensions`) correctly forces an untrusted state, but the
**result of the resolution was thrown away** and the manager was forced back to untrusted. The
subsequent `settingsManager.reload()` therefore reloaded global settings only and
`PackageManager.resolve()` returned no project resources — an approved decision never reached final
resource resolution, and `isProjectTrusted()` reported `false` for the rest of the session.

After: `this.settingsManager.setProjectTrusted(projectTrusted);` so the approval or denial governs
the settings reload and resource assembly that follow.

## Behaviour now

* Remembered `false` (and `true`) is authoritative; only `null`/missing consults the policy.
* Approved decisions reach `reload()` → merged project settings → project extensions.
* Denied decisions keep `isProjectTrusted() === false`, project settings empty and project
  extensions out of the final set; an extension-reported denial is remembered in the trust store.
* Trusted: project overrides root-level and nested keys, non-overridden nested global defaults
  survive, arrays are replaced.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` → passes (exit 0). The script drives
the real modules through `.prale-eval/subject.mjs` and asserts across module boundaries only
observable behaviour; asynchronous ordering is controlled with a deferred extension-hook promise
(no timers, randomness or network).

Mutation check (performed locally, each file restored alone to the fixture baseline while the other
two stayed repaired) — each run fails for the right reason:

| restored file | failing assertion |
| --- | --- |
| `project-trust.ts` | `a stored denial must not fall through to defaultProjectTrust=always` |
| `settings-manager.ts` | `project settings must override global settings` |
| `resource-loader.ts` | `an approved decision must be applied` |

Temporary fixtures (`/.prale-eval/.tmp-regression-fixtures`) are created and removed by the script
inside the workspace. Limitation: the repository's vitest suites were not run because no
`node_modules` are installed and dependencies must not be installed here; the only local runtime
requirement is Node 24 (`stripTypeScriptTypes` + `--experimental-vm-modules`).
