# T17 demo — fresh project extension gated behind an explicit trust decision

Repository: `pi` · Mode: `demo`

## What the demo shows

A **fresh extension fixture** — a project whose `.pi/extensions/` directory has just been created and
has no cached or previously loaded state — is unavailable during bootstrap and becomes available only
after an explicit trusted decision.

Two phases, both implemented in `packages/coding-agent/src/core/resource-loader.ts`:

1. **Bootstrap (untrusted).** `reload({ resolveProjectTrust })` calls
   `loadProjectTrustExtensions()`, which runs `setProjectTrusted(false)` and reloads settings before
   resolving resources. Project auto-discovery in `package-manager.ts`
   (`addAutoDiscoveredResources`) only collects `.pi/extensions` when
   `settingsManager.isProjectTrusted()` is true, so the fresh project extension is *not* collected.
   The bootstrap set exposed to the trust decision contains only user/global and temporary CLI
   extensions.
2. **Explicit trust decision.** The caller's `resolveProjectTrust` callback receives that bootstrap
   set and returns an explicit boolean. `reload` applies it with
   `settingsManager.setProjectTrusted(projectTrusted)` and reloads settings.
3. **Final set (trusted).** `loadFinalExtensionSet()` reuses the already-loaded pre-trust extensions
   and loads the remaining paths, which now include the project extension. The project extension is
   available in the final result.

Returning `false` from the explicit decision keeps the project extension unavailable in the final set.

## Executable demo

### Integration demo (real code, requires installed dependencies)

`packages/coding-agent/test/project-trust-extension-bootstrap.demo.test.ts` builds the fresh fixture
in a temp dir (a user extension at `<agentDir>/extensions/user.ts` and a project extension at
`<cwd>/.pi/extensions/project.ts`), drives `DefaultResourceLoader.reload` with a `resolveProjectTrust`
callback, and asserts:

- the callback's `extensionsResult` (the bootstrap set) equals `[user.ts]` and does **not** contain
  the project extension; and
- after returning `true`, `loader.getExtensions()` equals `[project.ts, user.ts]`; and
- after returning `false`, the final set stays `[user.ts]`.

Run it:

```bash
# from packages/coding-agent
npx vitest run test/project-trust-extension-bootstrap.demo.test.ts

# or via the provided wrapper (checks for the vitest binary first)
bash .prale-eval/run-demo.sh
```

### Dependency-free contract harness + normalized operation result (runs here)

This workspace has **no installed `node_modules`**, so the vitest integration demo cannot be executed
in place. `.prale-eval/demo-bootstrap-trust.mjs` therefore runs with plain `node` and:

1. verifies the contract-bearing lines of the real `resource-loader.ts` still hold
   (435 `loadProjectTrustExtensions`, 438 `setProjectTrusted(false)`,
   452 `loadProjectTrustExtensions()`, 453 `resolveProjectTrust`, 454 `setProjectTrusted(projectTrusted)`,
   639 `loadFinalExtensionSet`); and
2. models the two-phase flow and prints the resulting extension set per phase.

Run and observed output:

```bash
$ node .prale-eval/demo-bootstrap-trust.mjs
PASS  line 435: bootstrap entry point exists
PASS  line 438: bootstrap forces project trust off
PASS  line 452: reload runs bootstrap before trust
PASS  line 453: reload awaits explicit trust decision
PASS  line 454: reload applies explicit decision
PASS  line 639: final set is assembled after trust
PASS  bootstrap withholds the fresh project extension
PASS  explicit trusted decision makes it available
{
  "operation": "resource-loader.bootstrap-then-explicit-trust",
  "fixture": "fresh",
  "bootstrap": { "projectTrusted": false, "extensions": ["<agentDir>/extensions/user.ts"] },
  "decision": { "kind": "explicit", "trusted": true },
  "final": {
    "projectTrusted": true,
    "extensions": ["<cwd>/.pi/extensions/project.ts", "<agentDir>/extensions/user.ts"]
  },
  "contractChecks": "pass"
}
All contract checks passed.
```

## Normalized operation result

| Phase | `projectTrusted` | Extension set | Project extension available? |
| --- | --- | --- | --- |
| Bootstrap (`loadProjectTrustExtensions`) | `false` | `[user.ts]` | No |
| After explicit `trusted = true` (`loadFinalExtensionSet`) | `true` | `[project.ts, user.ts]` | Yes |
| After explicit `trusted = false` | `false` | `[user.ts]` | No |

## Validation status

- `node .prale-eval/demo-bootstrap-trust.mjs` — **pass** (exit 0).
- `bash .prale-eval/run-demo.sh` (vitest integration demo) — **blocked**: `node_modules` is not
  installed in this workspace, so `vitest` is unavailable. Installing dependencies is out of scope
  for this task; the limitation is recorded rather than worked around.

## Scope

No task metadata, hidden-oracle files, package locks, or git configuration were modified. The only
changes are the demo test fixture, the runner, this document, and `.prale-eval/result.json`.
