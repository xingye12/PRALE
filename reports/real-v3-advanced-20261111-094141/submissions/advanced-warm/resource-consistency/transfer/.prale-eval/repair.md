# Repair: stored denial vs. configuration precedence

Three defects chained together across the trust → settings → resource-assembly path. Each
one is a small code change, but the incident is only visible across module boundaries, which
is why the regression test links the real modules together.

## 1. `packages/coding-agent/src/core/project-trust.ts` — stored boolean was not authoritative

`resolveProjectTrusted()` read the persisted decision from `ProjectTrustStore` and then wrote

```ts
const decision = options.trustStore.get(options.cwd);
if (decision) {          // `false` is a legitimate stored value, but also falsy
    return decision;
}
```

`ProjectTrustStore.get()` returns `boolean | null`, where `false` is an *explicit denial* and
`null` means "no decision recorded". Because the guard tested truthiness, a stored denial fell
through to the default policy (`defaultProjectTrust`, the asynchronous extension answer path,
or the interactive prompt) — i.e. an explicit "do not trust" was silently upgraded to
allow-by-default. Fix: test `decision !== null`, so only a missing entry falls through and both
stored booleans are authoritative.

## 2. `packages/coding-agent/src/core/settings-manager.ts` — merge precedence was inverted

`deepMergeSettings(base, overrides)` is documented as "project/overrides take precedence, nested
objects merge recursively", but it called `deepMergeObjects(overrides, base)`, swapping the two
layers. Consequences:

* the global layer won every leaf conflict, so a trusted project value (e.g. `theme`) never
  became effective — project configuration looked "lost" after an accepted reload;
* `applyOverrides()` (which merges runtime overrides on top of the merged settings) was inverted
  in the same way;
* nested survival happened to work only for the *global* side.

Fix: pass the layers in their documented order (`deepMergeObjects(base, overrides)`). Nested
objects still merge recursively, so global defaults survive next to project overrides
(`{ retry: { maxRetries: 9 } }` over `{ retry: { enabled: true, maxRetries: 5, baseDelayMs: 111 } }`
yields `{ enabled: true, maxRetries: 9, baseDelayMs: 111 }`).

Project values are still applied *only while trusted*: `loadFromStorage()` short-circuits the
project scope when `projectTrusted` is false, `setProjectTrusted()` clears/loads the project
layer, and `reload()` re-reads the project scope with the current trust state. Those paths were
already correct and are covered by the regression test.

## 3. `packages/coding-agent/src/core/resource-loader.ts` — the decision never reached assembly

During `DefaultResourceLoader.reload({ resolveProjectTrust })` the loader first runs a bootstrap
pass that forces untrusted settings (`loadProjectTrustExtensions()` → `setProjectTrusted(false)`
→ `reload()`), then asks the resolver for the decision, then re-released the settings for the
final resource assembly. That last step threw the answer away:

```ts
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(false);   // <- decision discarded
```

So even an approved project was assembled as untrusted: project settings never reached the
merged view, and trust-gated project resources (`SYSTEM.md`, `APPEND_SYSTEM.md`, project
settings/packages/extensions/skills/prompts/themes) stayed out of the resolved resource set.
Fix: apply the resolved value (`setProjectTrusted(projectTrusted)`), so the following
`settingsManager.reload()` and every downstream resolution pass see the approved decision. The
bootstrap pass itself is unchanged, so project-local code still never executes before the
decision is made. This mirrors the existing correct usage in `package-manager-cli.ts`.

## Cross-module behaviour asserted by `.prale-eval/regression.mjs`

1. Resolver boundary: a fake trust store returning `false` is honoured against
   `defaultProjectTrust: "always"`, never opens the interactive prompt, `true` is honoured
   against `"never"`, and only `null` falls through to the default policy.
2. Settings boundary: a storage double supplies global/project files; the merged view returns
   the trusted project value, keeps nested global defaults, is unaffected while untrusted,
   survives `reload()`, and `applyOverrides()` still wins.
3. Assembly boundary: the real `SettingsManager` is injected into the real
   `DefaultResourceLoader`; after `reload()` with an approving resolver the manager reports the
   approved trust, the project configuration is in effect, and the loader resolves the
   project-only `SYSTEM.md`/`APPEND_SYSTEM.md`; a denying resolver keeps everything global.

Filesystem, path helpers, package manager, extension/skill/prompt/theme loaders and the trust
store are boundary fakes, so no real time, randomness, network or external state is involved.

Validation: `node --experimental-vm-modules .prale-eval/regression.mjs` passes on the repair and
fails with a plain `AssertionError` (exit code 1, no crash/import error) when
`project-trust.ts`, `settings-manager.ts`, or `resource-loader.ts` alone is restored to its
faulty baseline.
