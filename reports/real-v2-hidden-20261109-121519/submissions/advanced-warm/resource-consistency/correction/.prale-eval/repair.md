# Repair: session-only trust must not become permanent consent

## Failure chain

The incident spans three modules that hand trust decisions to one another:

1. `DefaultResourceLoader.reload()` called `loadProjectTrustExtensions()` for an
   untrusted bootstrap pass, then discarded the caller-supplied resolver:
   `const projectTrusted = false;`. `options.resolveProjectTrust` was never
   invoked, so the resolver never ran, the bootstrap result was ignored, and
   every reload behaved as if the project were untrusted.
2. `SettingsManager.setProjectTrusted()` guarded its body with the inverted
   condition `if (this.projectTrusted !== trusted) return;`. A real trust
   transition was skipped: the forced untrusted bootstrap kept project settings
   loaded, and a later approval/denial never reloaded `projectSettings`. The
   loader's later `reload()` could only re-read the stale trust bit.
3. `resolveProjectTrusted()` persisted an extension decision whenever
   `result.remember !== undefined`, so both `remember: false` and an omitted
   `remember` wrote consent. A session-only approval became a permanent "true"
   entry in the trust store; a session-only denial wrote a permanent "false".

Together these produced the reported policy violation: project resources leaked
during bootstrap, a trusted decision did not take effect, and session-only
choices were written to disk.

## Cross-module fix

- `resource-loader.ts`: after the untrusted bootstrap, call the resolver exactly
  once with the bootstrap extension set, then apply its boolean result via
  `setProjectTrusted`. The bootstrap still runs with trust forced off, and the
  returned extension set is reused so user/CLI extensions are loaded only once.
- `settings-manager.ts`: return early only when trust is unchanged. An actual
  transition clears cached project settings/field modifications when trust is
  revoked and re-reads project settings from storage when trust is granted.
- `project-trust.ts`: persist only when `result.remember === true`. Session-only
  approval and denial still return their decision to the caller for this
  session, but write nothing to the trust store. Approvals and denials with
  `remember: true` both persist their respective boolean.

The fixes preserve every existing public API; no signatures or call sites
changed. Global settings storage is only ever read during these transitions, so
no trust decision mutates global configuration.

## Validation

Command (run from the workspace root):

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

The regression links the submitted `project-trust.ts`, `resource-loader.ts` and
`settings-manager.ts` through the read-only `.prale-eval/subject.mjs` pipeline.
Only the trust store, extension event delivery, package resolution and extension
loader are faked; the resolver, `SettingsManager` parsing/merging, bootstrap and
final resource selection are real. It asserts:

- a session-only approval runs the resolver exactly once, resolves the first
  bootstrap package pass with `projectTrusted === false` and global-only
  settings, then loads project settings/extensions;
- a session-only denial stays closed, leaves project settings empty and never
  persists consent;
- `remember: true` persists exactly `[cwd, true]` on approval and
  `[cwd, false]` on denial;
- `remember: false` persists nothing in either direction;
- toggling trust on a live loader reloads project settings in both directions;
- `SettingsManager.setProjectTrusted` alone clears and restores project settings
  while global settings storage stays byte-identical.

Ordering is controlled with awaited promises; no real time, randomness, network
or external services are used.

Falsification (mutation check): each repaired source file was restored alone to
its faulty `HEAD` baseline, the regression was run, and the file was restored.
All three produced a genuine `node:assert/strict` `AssertionError` (exit 1), not
a crash, import error or timeout:

| Restored file | Observed failure |
| --- | --- |
| `project-trust.ts` | `remember:false must not persist approval` |
| `settings-manager.ts` | `the bootstrap resolve must see an untrusted project and global-only settings` |
| `resource-loader.ts` | `resolver must run exactly once after the untrusted bootstrap` |

Temporary backups and the mutation driver were created under `.prale-eval/` and
removed afterwards; only `regression.mjs`, `result.json` and this report remain
alongside the read-only `subject.mjs`.
