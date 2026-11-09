# Repair: revocation must clear cached resources and settings

## Symptom chain

A headless (`hasUI: false`) reload with no stored trust decision under `ask` policy silently
granted trust, and a previous approval could never be revoked: the next resolved resource set
kept project configuration and project extensions. Three independent defects on the
producer → consumer path caused this.

## Root causes and fixes

1. `packages/coding-agent/src/core/project-trust.ts:86-89` (producer)
   `resolveProjectTrusted` returned `true` when the prompt could not be shown (`hasUI` false).
   Missing UI is not consent; an unanswerable `ask` must fail closed. Now returns `false`, while
   `trustOverride`, stored decisions and the `always`/`never` policies keep their existing
   semantics, and an available UI still returns the selected option.

2. `packages/coding-agent/src/core/settings-manager.ts:523-527` (state owner)
   `setProjectTrusted(false)` assigned `projectSettings` to itself — a no-op — so the cached
   project configuration, its merged view and `defaultModel`/`compaction` overrides survived
   revocation until something re-read storage. Revocation now resets `projectSettings` to `{}`
   and rebuilds the merged view from global settings immediately.

3. `packages/coding-agent/src/core/resource-loader.ts:453-455` (consumer)
   `reload()` computed `projectTrusted` from `resolveProjectTrust` but then unconditionally called
   `settingsManager.setProjectTrusted(true)`, discarding a denial. It now forwards the resolver's
   decision. The resolver is still consulted exactly once per reload, after a pre-trust extension
   pass (`loadProjectTrustExtensions`) that excludes project extensions and project settings, and
   the reload without a resolver still never touches the retained trust state.

Why the ordering matters: the loader's pre-trust pass sets trust to `false`, asks the resolver,
then applies the answer and reloads settings for that final state. Package resolution afterwards
reads `settingsManager.isProjectTrusted()` and the merged settings, so both the settings cache and
the trust flag must agree; a stale flag or stale project settings each leak project extensions
back into the resolved set.

## Regression coverage (`.prale-eval/regression.mjs`)

The script drives the real modules through `subject.mjs`: real `resolveProjectTrusted`, real
`DefaultResourceLoader.reload`/`extensionsResult`, real `SettingsManager` parsing/merge/trust code
and real package-resolution ordering; only storage, package manager, extension loader, trust
event, trust store and UI are faked boundaries. Values crossing the VM boundary are normalized
before strict comparison because guest-realm arrays/objects carry different prototypes.

Scenarios:

- headless `ask` with no stored decision denies, keeps only global + CLI extensions, clears
  project settings, keeps global `defaultModel`/`compaction`, and writes no consent entry;
- approval resolves project extensions and merges project settings, then revocation removes the
  project extension, restores global settings and leaves the stored project file untouched;
- while the resolver promise is pending, trust stays denied and project settings stay hidden; the
  denial is applied only after the resolver settles (ordering controlled with promises, no timers);
- reload without a resolver retains approval and retains revocation, without re-running the trust
  decision;
- stored approvals/denials are still honored headlessly (the fix does not deny everything);
- an interactive `ask` approval still grants session-only trust and persists nothing;
- direct revocation via the real resolver output asserts the immediate discard contract that a
  later `reload()` would otherwise mask (the reload re-reads storage as untrusted).

Mutation check (performed locally, each file restored to the fixture baseline alone):

| mutated file | result |
| --- | --- |
| `project-trust.ts` | fails `headless reload without a stored decision and "ask" policy must not grant trust` |
| `settings-manager.ts` | fails `revoking trust must discard cached project settings immediately` |
| `resource-loader.ts` | fails `headless reload without a stored decision and "ask" policy must not grant trust` |

Every failure is an uncaught `node:assert/strict` assertion (exit 1), not a crash or import error.

## Scope

Only the three listed production modules changed, plus files under `.prale-eval/`. Existing APIs,
the interactive prompt path, stored-decision handling and unrelated settings behavior are intact.
No dependencies, network, credentials or timers are used; scratch inputs under
`.prale-eval/.tmp-regression` are created and removed by the script itself.
