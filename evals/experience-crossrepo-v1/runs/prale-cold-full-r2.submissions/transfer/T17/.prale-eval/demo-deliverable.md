# Demo deliverable — fresh project extension is unavailable until an explicit trusted decision

Task: `T17` (repository `pi`, mode `demo`).

## What the demo shows

A throwaway fixture project ships one fresh project extension at
`<project>/.pi/extensions/fresh-project-extension.ts`, and the isolated agent
directory ships one user extension at `<agentDir>/extensions/user-extension.ts`.
Running the repository's real `DefaultResourceLoader` produces this normalized
operation result:

| Phase | Observed `getExtensions().extensions` |
| --- | --- |
| Bootstrap (`loadProjectTrustExtensions()`) | `[<agentDir>/extensions/user-extension.ts]` — the fresh project extension is **unavailable** |
| `reload({ resolveProjectTrust: async () => true })` | `[<project>/.pi/extensions/fresh-project-extension.ts, <agentDir>/extensions/user-extension.ts]` — available **only after the explicit trusted decision** |
| `reload({ resolveProjectTrust: async () => false })` | `[<agentDir>/extensions/user-extension.ts]` — an explicit denial keeps it unavailable |

The `resolveProjectTrust` callback also asserts the contract from the inside: the
`extensionsResult` it receives is the bootstrap snapshot, which never contains
the project fixture extension.

## Executable demo

```
# from the workspace root
node --import ./.prale-eval/demo/register.mjs .prale-eval/demo/run-demo.mjs
```

Exit code `0` and `7/7 checks passed` on the current checkout. Captured output:
`.prale-eval/demo/validation-output.txt`.

Files:

| Path | Role |
| --- | --- |
| `.prale-eval/demo/run-demo.mjs` | The demo: builds the fixture, runs the real `DefaultResourceLoader`, asserts the bootstrap / trusted / denied phases, cleans up the fixture in `finally`. |
| `.prale-eval/demo/register.mjs` | `node --import` entry that registers the offline resolution hooks. |
| `.prale-eval/demo/hooks.mjs` | Resolution hook: bare non-builtin specifiers → offline stubs; intercepts only `./virtual-modules.ts` (which would otherwise pull `packages/coding-agent/src/index.ts`); everything else, including all repository `.ts` sources, loads normally. |
| `.prale-eval/demo/stub-overrides.json` | Small functional shims (`chalk`, `ignore`, `minimatch`, `semver`, `proper-lockfile`, `jiti`/`jiti/static` import bridge) and value overrides (e.g. `DEFAULT_MAX_AGENT_RETRY_DELAY_MS`). |
| `.prale-eval/demo/stub-exports.json` + `scan-exports.mjs` | Generated export surface for stubbed packages (reproducible via `node .prale-eval/demo/scan-exports.mjs`). |

The fixture itself is written and deleted at runtime under
`.prale-eval/demo/.tmp/`; no repository source, task metadata, lockfile or git
configuration is modified.

## Contract exercised in the repository

1. `DefaultResourceLoader.loadProjectTrustExtensions()`
   (`packages/coding-agent/src/core/resource-loader.ts:435-441`) forces
   `settingsManager.setProjectTrusted(false)`, reloads settings and calls
   `loadCurrentExtensionSet({ includeInlineFactories: true })`. Project
   settings are dropped and the package manager's auto-discovery skips
   `.pi/extensions`, so the project fixture cannot appear in the bootstrap set.
2. `DefaultResourceLoader.reload()`
   (`packages/coding-agent/src/core/resource-loader.ts:443-455`) runs that
   bootstrap pass, hands the bootstrap result to the caller's
   `resolveProjectTrust` callback, and applies the returned boolean with
   `setProjectTrusted(projectTrusted)` **before** resolving and loading the
   final set.
3. `DefaultPackageManager.addAutoDiscoveredResources`
   (`packages/coding-agent/src/core/package-manager.ts:2382-2470`) gates the
   `.pi/extensions` (and project skills/prompts/themes) discovery blocks behind
   `if (projectTrusted)`, while user-scope auto-discovery runs unconditionally —
   hence "user extension always visible, project extension only after trust".
4. `SettingsManager.setProjectTrusted`
   (`packages/coding-agent/src/core/settings-manager.ts:514-535`) is the state
   transition: `false` clears project settings, `true` re-loads them.
5. `DefaultResourceLoader.loadFinalExtensionSet`
   (`packages/coding-agent/src/core/resource-loader.ts:639-687`) reuses the
   pre-trust loaded extension by resolved path and loads only the remaining
   (now trusted) paths, so the project extension appears exactly once.

## Limitations recorded

* This checkout has no `node_modules` and dependencies must not be installed, so
  the npm packages imported transitively by the real sources
  (`chalk`, `ignore`, `minimatch`, `semver`, `proper-lockfile`, `jiti`,
  `@earendil-works/*` workspaces, `highlight.js`, `typebox`) cannot be resolved
  natively. The demo substitutes deterministic offline stubs for those
  specifiers only; every repository `.ts` file that participates in the trust
  gate is loaded, type-stripped and executed unmodified by Node.
* For the same reason the repository's own vitest suite
  (`npm test --workspace=@earendil-works/pi-coding-agent`, which contains
  `packages/coding-agent/test/resource-loader.test.ts` covering the same
  bootstrap/trust flow) could not be executed here.
