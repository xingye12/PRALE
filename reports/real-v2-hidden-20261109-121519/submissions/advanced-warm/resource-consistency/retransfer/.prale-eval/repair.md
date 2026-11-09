# Repair: revocation must clear cached resources and settings

Task: `advanced/resource-consistency/retransfer` (repository `earendil-works/pi`)

## Incident

A headless reload with no stored trust decision and the default `ask` policy granted
access instead of denying it. After a previous approval, revoking trust did not take
effect: project configuration stayed cached and project extensions were still part of
the next resolved resource set. Global and CLI resources had to be preserved, and a
reload without a resolver had to retain whatever trust state already existed.

## Faulty production code (three hops of one chain)

The trust decision flows across three modules, and each hop was independently broken:

1. `packages/coding-agent/src/core/project-trust.ts` — `resolveProjectTrusted()`
   returned `true` when `projectTrustContext.hasUI` was false, i.e. a missing prompt
   surface was treated as implicit consent. Headless/print/json/rpc reloads therefore
   approved themselves.

2. `packages/coding-agent/src/core/resource-loader.ts` — `DefaultResourceLoader.reload()`
   called `loadProjectTrustExtensions()` (a deliberately untrusted bootstrap pass),
   asked the injected `resolveProjectTrust` resolver for a decision, and then discarded
   that decision: `this.settingsManager.setProjectTrusted(true);`. Every resolver-driven
   reload ended up trusted, so a revocation result was overwritten with consent.

3. `packages/coding-agent/src/core/settings-manager.ts` —
   `SettingsManager.setProjectTrusted(false)` self-assigned
   `this.projectSettings = this.projectSettings;`. Revocation flipped the flag and
   recomputed merged settings from the *same* cached project configuration, so project
   values (e.g. `defaultModel`, `extensions`, `compaction`) kept influencing resolution
   until some later `reload()` happened to re-read storage.

## Fix (minimal, APIs unchanged)

- `project-trust.ts`: the no-UI branch now returns `false`. A prompt that cannot be
  shown fails closed; only an override, a stored decision, an `always` policy with a
  real resolver result, or an explicit UI/extension decision can grant trust.
- `resource-loader.ts`: the resolved value is applied — `setProjectTrusted(projectTrusted)` —
  so an approval or a revocation from the resolver actually determines the state used
  by the subsequent `settingsManager.reload()`/`packageManager.resolve()` pass.
- `settings-manager.ts`: the revocation branch replaces cached project settings with
  `{}`, clears the project load error and recomputes merged settings from global
  settings only, so the discard is immediate rather than deferred until a reload.

Ordering guarantee after the repair: bootstrap pass with trust forced off → resolver
decision (override / stored / policy / UI / extension) → trust applied → settings
reloaded for that trust state → resource resolution. Because the bootstrap pass runs
untrusted and the revision is applied before the final resolve, project configuration
and project extensions can never leak into a revoked resolution, while global and CLI
resources are resolved independently of trust and are preserved.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (Node v24.14.0, from the
workspace root) — `.prale-eval/regression.mjs` uses the read-only
`.prale-eval/subject.mjs` graph so that the real `project-trust`, `resource-loader` and
`settings-manager` implementations import one another; only in-memory settings storage,
extension loading, package resolution and the trust UI/extension boundaries are faked.
It asserts observable behavior without timers or randomness:

- headless + `ask` + no stored decision ⇒ deny;
- stored denial/approval, explicit override, `never`/`always` policies and an
  `approve once` UI selection behave correctly (and approve-once is not persisted);
- `setProjectTrusted(false)` empties `getProjectSettings()` and merged values fall back
  to global immediately;
- resolver-driven reload with no consent resolves only CLI + global extensions, with
  every observable `resolve()` seeing `trusted === false`;
- approval exposes project settings and the project extension; reload without a
  resolver keeps trust and resources and never re-prompts;
- revocation (stored denial or explicit override) clears project configuration, removes
  the project extension from the next resolved set, keeps global extensions/compaction
  and CLI extensions, and a later resolver-less reload keeps the revoked state.

Mutation evidence (each production file restored alone to its faulty baseline):

| Faulty file | Result |
| --- | --- |
| `project-trust.ts` (`hasUI` ⇒ `true`) | `AssertionError: missing UI must fail closed, not imply consent` |
| `settings-manager.ts` (`projectSettings = projectSettings`) | `AssertionError: revocation must clear cached project configuration` |
| `resource-loader.ts` (`setProjectTrusted(true)`) | `AssertionError: headless ask reload must leave the project untrusted` |

Each run exited 1 with a real `node:assert/strict` failure — no crash, import error or
timeout — and the repair was restored afterwards with all scenarios green.

## Limitations

- Only Node 24 built-in modules are used. The repository's vitest/tsgo suites were not
  run because `node_modules` is not installed and installing dependencies is out of
  scope for this task; the subject helper is the intended focused validation surface.
- No temporary files are created: all fixture state is in-memory inside the subject
  helper, so manual validation stays inside the workspace with nothing to clean up.
