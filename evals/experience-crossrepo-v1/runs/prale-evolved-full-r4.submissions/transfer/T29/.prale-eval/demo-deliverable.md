# T29 demo — project extension trust gate

**Repository:** `pi` (`packages/coding-agent`)
**Mode:** demo
**Deliverable:** `.prale-eval/result.json`, this document, and the executable demo
`.prale-eval/demo/project-trust-bootstrap.test.ts`.

## What is being demonstrated

A *fresh* project extension fixture (a `.pi/extensions/project.ts` created on the fly)
is **unavailable during the bootstrap pass** and becomes **available only after an
explicit trusted decision**.

The demo drives the production loader rather than re-implementing it:

- `DefaultResourceLoader.reload({ resolveProjectTrust })`
  (`packages/coding-agent/src/core/resource-loader.ts:443`)
- → `DefaultResourceLoader.loadProjectTrustExtensions()` (`:435`), the bootstrap pass
- → `resolveProjectTrust` callback (`ResourceLoaderReloadOptions`, `:36`)
- → `DefaultResourceLoader.loadFinalExtensionSet()` (`:639`)

## Contract

`ResourceLoaderReloadOptions.resolveProjectTrust` is the explicit-decision seam:

```ts
export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}
```

`reload` implements the gate:

1. **Bootstrap (untrusted).** When `resolveProjectTrust` is supplied,
   `loadProjectTrustExtensions()` calls `settingsManager.setProjectTrusted(false)` and
   reloads settings, then loads the current extension set. Project-local extensions are
   filtered out of that result by the untrusted settings scope; user/global and temporary
   CLI extensions still load.
2. **Explicit decision.** `reload` awaits
   `options.resolveProjectTrust({ extensionsResult: preTrustExtensions })` and applies the
   returned boolean with `settingsManager.setProjectTrusted(projectTrusted)`.
3. **Final resolution.** `loadFinalExtensionSet()` indexes the bootstrap extensions by
   resolved path, loads only the `remainingPaths` (which now include the project extension
   when trusted), reuses the bootstrap `runtime`, and returns the ordered final set.

Therefore the project extension appears in `loader.getExtensions()` **only** when the
explicit decision was `true`.

## Normalized operation result

The suite emits one JSON record per decision. Shape:

```json
{
  "operation": "resource-loader.reload.resolveProjectTrust",
  "decision": "trusted | untrusted",
  "bootstrapExtensions": ["<agentDir>/extensions/user.ts"],
  "finalExtensions": ["<cwd>/.pi/extensions/project.ts", "<agentDir>/extensions/user.ts"],
  "projectExtensionAvailableAfterDecision": true
}
```

- `decision: "trusted"` → `bootstrapExtensions` contains only the user extension;
  `finalExtensions` additionally contains the project extension;
  `projectExtensionAvailableAfterDecision` is `true`.
- `decision: "untrusted"` → `bootstrapExtensions` and `finalExtensions` both omit the
  project extension; `projectExtensionAvailableAfterDecision` is `false`.

The assertions in the suite check exactly these facts, plus that the project extension
registers its `project-only` command in the trusted case.

## How to run the demo

From the repository root (dependencies installed):

```sh
npx vitest --run --config packages/coding-agent/vitest.config.ts \
  .prale-eval/demo/project-trust-bootstrap.test.ts
```

The demo is self-contained: it creates the fresh fixture in a temp directory and removes
it in `afterEach`. No repository files are modified.

## Validation status

- **Passed:** `.prale-eval/validate-citations.mjs` (dependency-free Node) verified that
  every `evidence` entry's inclusive `[start_line, end_line]` range in
  `packages/coding-agent/src/core/resource-loader.ts` actually contains the named symbol,
  that the required path is cited, and that every `claims` entry references a cited
  evidence path.
- **Blocked in this sandbox:** the vitest demo could not execute because the workspace has
  no `node_modules` and installing dependencies is out of scope. `npx --no-install vitest`
  reports `vitest@5.0.3` missing, and importing the loader directly fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'chalk'`. Re-run the vitest command above with
  dependencies present to exercise the demo end-to-end.

## Evidence

| path | symbol | lines |
| --- | --- | --- |
| `packages/coding-agent/src/core/resource-loader.ts` | `resolveProjectTrust` | 36–38 |
| `packages/coding-agent/src/core/resource-loader.ts` | `loadProjectTrustExtensions` | 435–440 |
| `packages/coding-agent/src/core/resource-loader.ts` | `reload` | 443–457 |
| `packages/coding-agent/src/core/resource-loader.ts` | `loadFinalExtensionSet` | 639–691 |
