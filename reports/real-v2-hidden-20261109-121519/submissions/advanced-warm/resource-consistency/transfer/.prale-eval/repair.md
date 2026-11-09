# Repair: remembered denial and configuration precedence disagree

## Incident summary

Two symptoms shared one root cause chain across three modules:

1. A project the user had explicitly **denied** was treated as "no decision" and fell through to the
   `defaultProjectTrust` policy (`ask`/`always`), which can allow project resources.
2. A project the user **approved** was re-pinned to the untrusted bootstrap state by the resource
   loader, so project settings/extensions were dropped from the final resource resolution — and the
   settings merge itself gave global values precedence over project values when both were loaded.

## Faulty production code and fixes

### 1. `packages/coding-agent/src/core/project-trust.ts`

`ProjectTrustStore.get()` returns `boolean | null`, but the resolver used a truthiness test:

```ts
const decision = options.trustStore.get(options.cwd);
if (decision) {          // stored `false` is falsy -> treated as "no decision"
	return decision;
}
```

A remembered **denial** (`false`) therefore fell through to the allow-by-default policy (and to an
interactive prompt). Fix: only an absent decision (`null`/`undefined`) falls through, so a stored
boolean — approval *or* denial — is authoritative:

```ts
if (decision !== null && decision !== undefined) {
	return decision;
}
```

### 2. `packages/coding-agent/src/core/settings-manager.ts`

`deepMergeSettings(base, overrides)` documents "project/overrides take precedence, nested objects
merge recursively", but it passed its arguments to `deepMergeObjects` in the wrong order:

```ts
return deepMergeObjects(overrides, base);  // base won every conflict
```

Because `deepMergeObjects` copies keys from `overrides` on top of `base`, the swapped call made the
*global* layer win over the project layer, and `applyOverrides` lose to the settings it was meant to
override. Fix: pass `(base, overrides)`. Recursive merging is unchanged, so nested global defaults
(`compaction.keepRecentTokens`) still survive a partial project override
(`compaction.reserveTokens`).

### 3. `packages/coding-agent/src/core/resource-loader.ts`

`DefaultResourceLoader.reload()` bootstraps an untrusted pass (correct, project extensions are not
executed before consent), then resolves project trust — but discarded the result:

```ts
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(false);   // always re-pinned to untrusted
```

Consequences: `packageManager.resolve()` and every later trust-gated read
(`discoverSystemPromptFile`, project settings load in `SettingsManager.reload`) still ran untrusted,
so approved project configuration and extensions never reached final resource resolution. Fix:
forward the decision, `this.settingsManager.setProjectTrusted(projectTrusted)`.

The intentional untrusted bootstrap in `loadProjectTrustExtensions()` is untouched.

## Cross-module behavior restored

```
resolveProjectTrusted (project-trust)
        │  stored boolean authoritative (denial or approval)
        ▼
DefaultResourceLoader.reload (resource-loader)
        │  decision forwarded, not replaced with `false`
        ▼
SettingsManager.setProjectTrusted + reload (settings-manager)
        │  trusted -> project layer loaded and merged over global (nested merge)
        ▼
packageManager.resolve / final extension set
           trusted  -> global + project configuration and resources
           untrusted -> global only, nested global defaults intact
```

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (Node 24, no dependencies) loads the real
`project-trust`, `settings-manager` and `resource-loader` modules through `.prale-eval/subject.mjs`
and asserts, using uncaught `node:assert/strict` assertions:

- stored `false` beats `always`/`ask` and is never re-prompted; stored `true` beats `never`;
  only `null` defers to the default policy;
- trusted project values override global values while `getGlobalSettings()` stays intact and nested
  global defaults survive; untrusted managers expose no project settings; toggling trust in either
  direction and `reload()` keep the correct layer;
- the end-to-end pipeline (resolver → loader → SettingsManager → package resolution) loads
  `global` + `project` when approved and only `global` when denied/untrusted, observes
  `isProjectTrusted()`/`project-model` at resolution time, and keeps project configuration on a
  second accepted reload;
- asynchronous ordering is driven by promises: while the trust decision is pending the bootstrap
  pass is untrusted and project extensions are excluded; after the deferred decision settles the
  approval is applied.

Verified by restoring each production file alone to its faulty baseline: each run fails with a
specific assertion (denial policy, project-over-global precedence, approval reaching
SettingsManager) rather than crashing, and the fully repaired tree passes. Test inputs are
in-memory storage fixtures, so no temporary files are left behind.
