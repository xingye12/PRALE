# Session-only approval must not become permanent consent

## Symptom

Project trust resolution was inconsistent across three collaborating modules:

- A trusted decision made for the current process had no effect on which settings were loaded.
- The trust resolver passed to the resource loader was never invoked, so the "bootstrap
  untrusted, then decide" flow silently degraded into "always untrusted".
- An extension that answered `project_trust` with an explicit `remember: false` still wrote a
  durable decision into `~/.pi/agent/trust.json`, turning a session-scoped answer into consent
  for every later process.

## Root causes and repairs

### 1. `packages/coding-agent/src/core/settings-manager.ts` — trust switch was a no-op

`SettingsManager.setProjectTrusted()` guarded with an inverted comparison, so it returned early
exactly when the trust state really changed:

```ts
// before
if (this.projectTrusted !== trusted) {
    return;
}
// after
if (this.projectTrusted === trusted) {
    return;
}
```

Because of that, `projectTrusted` never flipped, `projectSettings` were never (re)loaded from
`.pi/settings.json`, and `reload()` kept reading project settings with the stale trust flag.
Granting trust "for this session" therefore behaved like a permanent denial; a denial after a
temporary grant could not drop project settings either. Re-applying the same decision stays a
no-op, so the public API and its idempotency are preserved.

### 2. `packages/coding-agent/src/core/resource-loader.ts` — resolver never ran

`DefaultResourceLoader.reload()` accepted a `resolveProjectTrust` callback, performed the
untrusted bootstrap pass (`loadProjectTrustExtensions()`), then discarded the callback and
hard-coded `const projectTrusted = false;`:

```ts
// before
preTrustExtensions = await this.loadProjectTrustExtensions();
const projectTrusted = false;
this.settingsManager.setProjectTrusted(projectTrusted);
// after
preTrustExtensions = await this.loadProjectTrustExtensions();
const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
this.settingsManager.setProjectTrusted(projectTrusted);
```

The repair keeps the bootstrap ordering intact (project settings and project extensions are
still excluded while the resolver runs), asks the resolver exactly once with the bootstrap
extension set, and then applies the returned decision to the settings manager before the
settings reload. The second settings reload in `reload()` now runs with the resolved trust state,
so a session approval actually loads `.pi/settings.json`, project packages, and project
extensions; a denial leaves them out. `loadFinalExtensionSet` still reuses the extensions that
the bootstrap already loaded, so user extensions are not executed twice. `reload()` without a
resolver keeps the previous behaviour and never asks for a decision again.

### 3. `packages/coding-agent/src/core/project-trust.ts` — `remember` was treated as tri-state

`resolveProjectTrusted()` persisted any extension decision whose `remember` field was merely
*defined*:

```ts
// before
if (result.remember !== undefined) {
    options.trustStore.set(options.cwd, trusted);
}
// after
if (result.remember === true) {
    options.trustStore.set(options.cwd, trusted);
}
```

`ProjectTrustEventResult.remember` is optional consent, not a tri-state: only an explicit
`remember: true` may write `trust.json`. Session-only approvals (`{ trusted: "yes" }`) and
explicit refusals to persist (`remember: false`) now stay in memory for the process only, for
both approvals and denials. The built-in prompt path is unchanged and still persists the
explicit "Trust" / "Do not trust" choices while the "(this session only)" options write nothing.
No decision mutates global settings (`~/.pi/agent/settings.json`); only the dedicated trust
store can be written, and only on explicit `remember: true`.

## Cross-module behaviour now guaranteed

1. `reload({ resolveProjectTrust })` → untrusted bootstrap (`isProjectTrusted() === false`,
   project extensions absent) → resolver called once → decision applied →
   `SettingsManager.setProjectTrusted()` switches state and reloads project settings →
   final resource set reflects the decision.
2. Approval: project settings, project resources, and project extensions load.
3. Denial: they stay out, identical to the bootstrap result.
4. `remember: true` persists approval **and** denial; anything else is session-only.
5. Global configuration is never rewritten by a trust decision.

## Validation

`.prale-eval/regression.mjs` links the real `settings-manager.ts`, `resource-loader.ts`,
`project-trust.ts`, and `trust-manager.ts` through `.prale-eval/subject.mjs`, and fakes only true
process boundaries (temp agent/project directories, `chalk`, `proper-lockfile`, package/extension
discovery, and the `project_trust` event emitter). It asserts:

- `SettingsManager` switches trust in both directions, loads/drops project settings, and leaves
  the global settings file untouched.
- `DefaultResourceLoader.reload()` resolves trust exactly once, sees an untrusted bootstrap set,
  applies the decision to settings, and loads or omits project extensions accordingly.
- `resolveProjectTrusted()` persists only on `remember: true`, honours denials, leaves
  session-only choices ephemeral, reuses saved decisions, respects CLI overrides, and never
  mutates global settings.

`node --experimental-vm-modules .prale-eval/regression.mjs` passes on the repaired tree. Restoring
any single file to its faulty baseline makes it fail with a behavioural assertion (not a crash):
`settings-manager.ts` → "setProjectTrusted(true) must update the trust state";
`resource-loader.ts` → "the trust resolver must run exactly once per reload";
`project-trust.ts` → the session-only persistence assertion.

Limitation: this workspace has no installed dependencies, so `vitest`, `tsc`, and `biome` cannot
run here; the regression script is the focused validation and exercises the production modules
directly.
