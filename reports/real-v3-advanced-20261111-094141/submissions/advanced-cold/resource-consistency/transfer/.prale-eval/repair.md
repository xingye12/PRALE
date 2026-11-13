# Repair: remembered denial and configuration precedence

Task: `advanced/resource-consistency/transfer` — repository `earendil-works/pi`.

The incident spans three modules of `packages/coding-agent/src/core/`. Each one had a
single, independent defect; together they explain both symptoms ("a stored denial
falls through to allow-by-default" and "accepted reloads lose project configuration").

## 1. Resolver — `core/project-trust.ts`

`resolveProjectTrusted()` asks the trust store for a remembered decision, which is
`boolean | null` (`null` = no decision recorded). The code tested the value for
truthiness:

```ts
const decision = options.trustStore.get(options.cwd);
if (decision) {          // a stored `false` is falsy -> treated as "undecided"
    return decision;
}
```

A remembered **denial** (`false`) therefore fell through to `defaultProjectTrust`
(`"always"` => allow) or to the interactive prompt — the reported "stored denial
unexpectedly falls through to an allow-by-default policy".

Repair: a stored boolean is authoritative in **both** directions.

```ts
const decision = options.trustStore.get(options.cwd);
if (typeof decision === "boolean") {
    return decision;
}
```

Only "no stored decision" (`null`/`undefined`) now reaches the default policy, and
the prompt/`trustOverride`/extension-decision paths are untouched.

## 2. Settings — `core/settings-manager.ts`

`deepMergeSettings(base, overrides)` documented "project/overrides take precedence,
nested objects merge recursively" but delegated to `deepMergeObjects` with the
arguments swapped, so the **base** (global) settings overwrote the **project**
settings:

```ts
return deepMergeObjects(overrides, base);  // global wins over project
```

Consequences: project configuration never overrode globals (so accepted reloads
appeared to "lose" project values), while nested project objects were also clamped
by their global counterparts.

Repair: keep the intended precedence (base = global defaults, overrides = project),
which preserves both required properties in one place:

```ts
return deepMergeObjects(base, overrides);  // project wins, globals fill the gaps
```

Because every scope merge (`constructor`, `setProjectTrusted`, `reload`,
`save`, `saveProjectSettings`, `applyOverrides`) funnels through this helper:

* while trusted, project values override global values (nested objects merge
  recursively, so a partial project override keeps the nested global defaults);
* while untrusted, `projectSettings` is `{}`, so only globals survive — project
  values are applied *only* while trusted.

## 3. Resource assembly — `core/resource-loader.ts`

`DefaultResourceLoader.reload()` performs an untrusted bootstrap pass
(`loadProjectTrustExtensions()` forces `setProjectTrusted(false)`), then resolves
the trust decision, and then discarded it:

```ts
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(false);   // accepted decision thrown away
```

The settings manager was therefore always left untrusted, so the following
`reload()` dropped project settings and `isProjectTrusted()` (which gates project
`SYSTEM.md`/`APPEND_SYSTEM.md`, project resources and project writes) stayed false
for the whole session.

Repair: carry the resolved decision into the manager before the settings reload:

```ts
this.settingsManager.setProjectTrusted(projectTrusted);
```

The subsequent `await this.settingsManager.reload()` (which preserves
`projectTrusted`) now reloads project settings/packages and project-scoped
resources whenever the decision was approved.

## Cross-module effect

`resolveProjectTrusted()` (resolver) → `DefaultResourceLoader.reload()`
(assembly) → `SettingsManager.setProjectTrusted()`/`reload()` (settings) form one
chain: a remembered `false` stops at the resolver, an approved decision is
propagated by the loader, and the settings manager applies project values only for
the duration the project is trusted, with nested global defaults preserved.

## Validation

`.prale-eval/regression.mjs` links the three real modules with `createGraph`
(boundary fakes only for filesystem/config/package/extension services) and asserts
observable behavior across the module boundaries:

1. `SettingsManager` (via `createStorage`): trusted project values override globals,
   nested global defaults survive a partial project override, revoking trust hides
   project values, re-trusting and `reload()` restore them.
2. `resolveProjectTrusted` (fake trust store): stored `false`/`true` beat
   `defaultProjectTrust: "always"/"never"`, `null` still falls back to the default
   policy, ask-without-UI denies, the interactive choice is persisted, and an
   extension decision still wins.
3. `DefaultResourceLoader.reload()` + real `SettingsManager` + real resolver: an
   approved decision reaches `isProjectTrusted()`, project settings and the final
   project `SYSTEM.md`; a remembered denial over `defaultProjectTrust: "always"`
   keeps global settings/system prompt.

All assertions are plain `node:assert/strict`; no timers, randomness, network or
external services are used. Restoring any one of the three files to its faulty
baseline makes the script fail with a specific `AssertionError` (verified for each
file individually), and the repaired tree passes.

Command: `node --experimental-vm-modules .prale-eval/regression.mjs` (Node 24; the
repository's vitest suite cannot run here because `node_modules` is not installed —
this is noted as the validation limitation).
