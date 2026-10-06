# T17 demo — project extension trust bootstrap

Repository: `pi` · Mode: `demo` · Task: `T17`

## What this demonstrates

A fresh project-scoped extension is **unavailable while the project is untrusted — including the
bootstrap pass** — and becomes available **only after an explicit trusted decision**. The demo
drives the real `DefaultResourceLoader`; nothing about the trust gate is stubbed.

## Executable demo

Command (once dependencies are installed):

```bash
cd packages/coding-agent && npm test -- --run test/trust-bootstrap-demo.test.ts
```

Artifacts:

| Artifact | Role |
| --- | --- |
| `packages/coding-agent/test/fixtures/trust-bootstrap/project/.pi/extensions/fresh-extension.ts` | Fresh **project** extension fixture (project-scoped). Bumps `globalThis.__piTrustBootstrapFreshLoads` so the demo can prove its module body never runs while untrusted. |
| `packages/coding-agent/test/fixtures/trust-bootstrap/agent/extensions/global-extension.ts` | User/global extension fixture. Stays available during bootstrap, proving the loader is running while the project fixture is withheld. |
| `packages/coding-agent/test/trust-bootstrap-demo.test.ts` | The demo: copies both fixtures into a throwaway project/agent dir and observes each phase of the trust handshake. |

## Contract exercised

The demo asserts this normalized operation result:

| # | Phase | Loader call | Expected extension set | Fresh module load count |
| --- | --- | --- | --- | --- |
| 1 | Bootstrap (collect trust input) | `loader.loadProjectTrustExtensions()` | `{global-extension.ts}` — project fixture **absent** | 0 |
| 2 | Explicit decision observed | callback `resolveProjectTrust({extensionsResult})` | `{global-extension.ts}` — project fixture still **absent** at decision time | 0 |
| 3 | Trusted decision `true` | `loader.reload({ resolveProjectTrust: … => true })` | `{fresh-extension.ts, global-extension.ts}` | 1 |
| 4 | Rejected decision `false` | `loader.reload({ resolveProjectTrust: … => false })` | `{global-extension.ts}` — project fixture **absent** | 0 |

`errors` is empty in every phase, so absence is a trust decision, not a load failure.

## Source grounding

`packages/coding-agent/src/core/resource-loader.ts`:

- `loadProjectTrustExtensions` (lines 435–441) — the bootstrap pass. It calls
  `this.settingsManager.setProjectTrusted(false)` **before** resolving, so project-scoped
  resources are excluded while user/global and temporary CLI extensions load.
- `reload` (lines 443–604, trust application at 450–455) — runs the bootstrap pass only when the
  caller supplies `resolveProjectTrust`, then applies the returned boolean with
  `this.settingsManager.setProjectTrusted(projectTrusted)` before the second settings reload and
  `packageManager.resolve()`. That explicit return value is the only switch that unlocks project
  extensions.
- `loadCurrentExtensionSet` (lines 606–633) — the single builder of the bootstrap extension set;
  it resolves packages under the current trust state, so the fixture path is absent pre-trust and
  present post-trust.
- `discoverSystemPromptFile` (lines 1093–1105) — the same `isProjectTrusted()` gate applied to
  another project resource (`.pi/SYSTEM.md`), confirming one shared trust signal.

## Validation status

`npm test -- --run test/trust-bootstrap-demo.test.ts` → **blocked** in this environment: the
repository has no installed `node_modules` and `vitest` is not on `PATH` (npm exits 127). Installing
dependencies is out of scope. Dependency-free fallback checks were run and passed:

1. `node --experimental-strip-types --check` on the demo test and both fixtures → exit 0.
2. Importing each fixture under Node 24 native type stripping → both default-export a function and
   register their command (`fresh-demo`, `global-demo`) when invoked with a stub `pi`.
3. The `resource-loader.ts` symbol/line-range citations above were re-checked against the source.

Run `npm install` (or `npm ci`) at the repo root, then re-run the demo command to execute the full
assertions.
