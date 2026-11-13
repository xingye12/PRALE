# Repair: session-only approval must not become permanent consent

## Incident trace (producer → consumer)

Project trust is produced by three cooperating modules in `packages/coding-agent`:

1. `core/extensions/runner.ts` — `emitProjectTrustEvent()` aggregates `project_trust` handlers and
   returns the first `yes`/`no` decision together with its optional `remember` flag.
2. `core/project-trust.ts` — `resolveProjectTrusted()` consumes that decision (or the saved store /
   prompt / default) and decides whether the project is trusted, and whether the decision is
   *persisted* to `trust.json`.
3. `core/resource-loader.ts` — `DefaultResourceLoader.reload({ resolveProjectTrust })` bootstraps the
   loader with an intentionally **untrusted** settings pass, asks the resolver once, then applies the
   answer by calling `SettingsManager.setProjectTrusted(...)` and reloading settings before the final
   extension/resource load.
4. `core/settings-manager.ts` — `setProjectTrusted()` is the consumer that must actually load or drop
   project settings when the trust state changes.

Three defects broke the invariant "a trusted decision may grant access for this session without
persisting consent":

### 1. `core/project-trust.ts` — implicit/negative `remember` was persisted

```diff
- if (result.remember !== undefined) {
+ if (result.remember === true) {
     options.trustStore.set(options.cwd, trusted);
 }
```

`remember` is optional (`remember?: boolean`). The old guard persisted whenever the key was present,
so an explicit `remember: false` — and any handler that merely set the field to false — wrote the
decision into `trust.json`, turning a session-only answer into permanent consent. Consent is now
persisted only for `remember === true`, covering both approval and denial.

### 2. `core/settings-manager.ts` — inverted guard swallowed trust changes

```diff
- if (this.projectTrusted !== trusted) {
+ if (this.projectTrusted === trusted) {
     return;
 }
```

The early return fired exactly when the trust value *changed*, so `setProjectTrusted(true)` after the
untrusted bootstrap returned immediately: project settings were never loaded, project writes stayed
blocked, and the "trust granted" decision had no observable effect. With the guard inverted, only a
genuine change reloads/drops project settings.

### 3. `core/resource-loader.ts` — resolver never ran and the bootstrap result was reused

```diff
 let preTrustExtensions: LoadExtensionsResult | undefined;
 if (options?.resolveProjectTrust) {
     preTrustExtensions = await this.loadProjectTrustExtensions();
-    const projectTrusted = false;
+    const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
     this.settingsManager.setProjectTrusted(projectTrusted);
 }
```

The untrusted bootstrap pass was correct, but its result was hard-coded back to `false` and the
caller-supplied resolver was never invoked. Consequently `resolveProjectTrusted()` never ran after the
untrusted bootstrap, no trust prompt/extension decision happened, and the session stayed untrusted no
matter what the caller decided. The resolver now runs **exactly once** per resolver-carrying reload,
receives the bootstrap `extensionsResult` (the untrusted pre-pass), and its boolean drives
`setProjectTrusted()` before the settings reload and the final extension set. Subsequent reloads
without a resolver still reuse the applied trust state and never re-resolve.

## Boundaries preserved

- No public API or signature changed; `resolveProjectTrusted`, `ProjectTrustStore`,
  `DefaultResourceLoader.reload(options)`, `SettingsManager.setProjectTrusted` keep their contracts.
- The untrusted bootstrap pass (`loadProjectTrustExtensions`) is unchanged, so project extensions and
  packages remain excluded while the decision is pending.
- Resolving trust never writes global configuration: only `trust.json` receives persisted decisions,
  and only when `remember === true`.

## Validation

`.prale-eval/regression.mjs` links the real modules through `.prale-eval/subject.mjs` and fakes only
outer boundaries (extension runner aggregation, lock file, package manager, extension loader,
theme/skill/prompt loaders, storage files):

- Graph A (`project-trust.ts` + `trust-manager.ts`): extension `yes`/`no` with absent or
  `remember: false` grants/denies for the session but leaves `trust.json` untouched; `remember: true`
  persists approval and denial and later sessions honour the denial; session-only prompt options never
  persist; persisted prompt answers do; overrides and `defaultProjectTrust` never persist; a project
  without trust-requiring resources is granted without consulting extensions.
- Graph B (`settings-manager.ts` over real files): `false → true` loads project settings and unblocks
  project writes, `true → false` drops them and restores global settings.
- Graph C (`resource-loader.ts` + `settings-manager.ts`): during the resolver the manager is still
  untrusted and sees the bootstrap extension set; the resolver runs exactly once; approval loads
  project settings and the trust-gated `.pi/SYSTEM.md`, denial keeps both gated, a later
  resolver-less reload does not re-resolve, and the global `settings.json` bytes never change.

Mutation check (each file reverted alone to the committed baseline, then restored):

| faulty file | detected by |
| --- | --- |
| `core/project-trust.ts` | `remember: false must not persist consent` |
| `core/settings-manager.ts` | `changing trust updates the trust state` |
| `core/resource-loader.ts` | `the resolver runs exactly once after the untrusted bootstrap` |

Limitation: the repository's own vitest suite could not be executed because no `node_modules` are
installed in this workspace (installation is out of scope); the standalone regression script above is
the focused validation and exercises the real production modules.
