# Cross-module repair: remembered denial vs. configuration precedence

Task: `advanced/resource-consistency/transfer` (repository `earendil-works/pi`, mode `repair`).

The incident spans one producer/consumer chain. `project-trust.ts` produces a trust
decision; `settings-manager.ts` turns that decision plus the two settings scopes into
one effective configuration; `resource-loader.ts` consumes both to assemble final
resources. Three independent defects broke the chain, and fixing any one alone is not
enough.

## 1. `project-trust.ts` — a stored boolean is authoritative

`resolveProjectTrusted` read the persisted decision and tested it for truthiness:

```ts
const decision = options.trustStore.get(options.cwd);
if (decision) {
    return decision;
}
```

`ProjectTrustStore.get` returns `boolean | null`, so a stored **denial** (`false`) was
indistinguishable from "no decision" and fell through to `defaultProjectTrust` — with
`"always"` that silently produced an allow. The check now distinguishes the stored
decision from the absence of one (`decision !== null && decision !== undefined`), so a
remembered `false` short-circuits before the default policy and before the interactive
prompt, and a remembered `true` likewise overrides `"never"`.

## 2. `settings-manager.ts` — project precedence with surviving nested defaults

`deepMergeObjects(base, overrides)` applies `overrides` last, but `deepMergeSettings`
passed its arguments in the opposite order:

```ts
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
    return deepMergeObjects(overrides, base); // base won
}
```

Every call site uses `deepMergeSettings(global, project)` (constructor, `reload`,
`setProjectTrusted`, `save`) or `deepMergeSettings(current, overrides)`
(`applyOverrides`), so the reversed arguments made **global** values win and project
edits no-op. The call is now `deepMergeObjects(base, overrides)`: project values win
while trusted, `applyOverrides` really overrides, and because the merge is still
recursive per key, nested defaults that the project file omits (for example
`compaction.keepRecentTokens`) are preserved instead of being replaced wholesale.

Precedence is still trust-gated in `loadFromStorage`/`reload`: while
`projectTrusted === false` the project scope loads as `{}`, so only global values are
ever merged.

## 3. `resource-loader.ts` — the decision must reach final resolution

`reload()` performs a bootstrap pass with project settings forced off, asks the
resolver for the decision, and must then re-apply that decision before the real
pass:

```ts
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(projectTrusted); // was setProjectTrusted(false)
```

The hard-coded `false` discarded the approved decision: the subsequent
`settingsManager.reload()` reloaded project settings as untrusted, so project
settings and project extensions never reached the final resource set even though the
user had just approved them. Passing the resolved value through closes the producer →
consumer path; a denial still leaves the runtime untrusted and keeps project resources
out.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs`

The script loads the real submitted modules through the read-only
`.prale-eval/subject.mjs` graph, which fakes only external boundaries (settings
storage, package manager, extension loading, consent UI, event bus). It asserts:

1. stored `false` beats an `"always"` default and never opens the prompt; stored
   `true` beats `"never"`; unset decisions still honour the policy; `"ask"` without a
   UI fails closed;
2. a trusted project scalar/nested value overrides global ones while untouched nested
   global defaults survive; untrusted state drops project values and re-trusting
   restores them; a real `settings.reload()` re-merges correctly;
3. one approval per reload flows through settings into final extension resolution
   (bootstrap pass untrusted, final pass trusted, project extension present), while a
   stored denial keeps project resources out;
4. extension-supplied approvals/denials cross the same boundary and are persisted when
   `remember` is set.

Each of the three source files was also restored individually to the faulty baseline
(with the fixed copy restored afterwards): the script failed with an uncaught
`node:assert/strict` `AssertionError` in every case — resolver group 1 for
`project-trust.ts`, settings group 2 for `settings-manager.ts`, and assembly group 3
for `resource-loader.ts` — never a crash, import error, or timeout.

No timers, randomness, network, or on-disk fixtures are used; ordering is controlled by
awaiting the pipeline promises. The repository's vitest suite could not be run because
the checkout has no installed `node_modules`, which is an environment limitation rather
than evidence about this change.
