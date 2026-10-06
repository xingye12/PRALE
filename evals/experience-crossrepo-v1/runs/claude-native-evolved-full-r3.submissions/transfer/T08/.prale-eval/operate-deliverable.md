# T08 — Operate deliverable: narrow, offline-safe fixture verification

**Repository:** `wattclaw` · **Task mode:** `operate` · **Task ID:** `T08`

## 1. What was built

An executable offline verification of a frontend/server fixture:

| Artifact | Purpose |
| --- | --- |
| `.prale-eval/verify-generated-file-path.test.mjs` | Executable demo — the verification itself |
| `.prale-eval/result.json` | Normalized operation result (evidence, claims, conclusion, validation) |
| `.prale-eval/operate-deliverable.md` | This document |

The fixture under test is the server-side helper
**`resolveGeneratedFileCandidatePath`** in
[`server/utils/generated-file-path.js`](../server/utils/generated-file-path.js#L1-L15).

## 2. The executable demo

Run from the repository root:

```bash
node --test .prale-eval/verify-generated-file-path.test.mjs
```

Observed result:

```
▶ resolveGeneratedFileCandidatePath (offline fixture)
  ✔ resolves a leading-slash downloads path from the workspace root (0.84ms)
  ✔ resolves an ordinary relative path from the workspace root (0.12ms)
  ✔ preserves an absolute path already inside the workspace (0.12ms)
  ✔ tolerates a trailing slash on the workspace root (0.09ms)
✔ resolveGeneratedFileCandidatePath (offline fixture) (2.31ms)
ℹ tests 4   ℹ pass 4   ℹ fail 0   ℹ duration_ms 55.5
```

The demo uses only Node's built-in `node:test` and `node:assert/strict`.
No packages, no install step, no configuration.

## 3. The contract being verified

`resolveGeneratedFileCandidatePath(workspaceReal, requestedPath)` maps a
workspace root plus a requested path to a normalized
`{ candidatePath, pathMode }` object with three outcomes:

| Input | `candidatePath` | `pathMode` |
| --- | --- | --- |
| Absolute path already under the workspace | unchanged | `workspace-absolute` |
| Leading-slash path (`/downloads/report.pdf`) | workspace root + path | `workspace-root-relative` |
| Ordinary relative path (`downloads/report.pdf`) | workspace root + path | `workspace-relative` |

Plus one normalization edge case: a trailing slash on the workspace root is
stripped before joining.

## 4. Why this is offline-safe / free of runtime + deployment dependencies

The fixture is **pure**: lines 1–15 of `generated-file-path.js` contain no
`import` statements and use only `String.prototype` methods (`replace`,
`startsWith`). It therefore has:

- no Gateway WebSocket dependency (`OpenClawGateway`),
- no SQLite / `better-sqlite3` dependency,
- no Express server or `express.json` body parsing,
- no `.env` parsing and no environment variables,
- no filesystem, subprocess, or network I/O,
- no installed `node_modules`.

Everything the function needs is passed in as already-fetched strings. In the
real server path, the runtime-dependent step is kept separate: the handler at
`server/handlers/files.js:112` first calls `gatewayExec('realpath -e …')`
(lines 107 and 124 — this is the part that needs a live Gateway) and only then
hands the resulting strings to the pure resolver. That separation is exactly
what makes the resolver independently verifiable offline.

By contrast, the repository's declared server-test entrypoint
`test:server` (`package.json:13`) shells out to `vitest run` over six server
test files and relies on devDependency `vitest` (`package.json:77`) plus the
app's native/runtime dependencies being installed — a heavier, less
offline-safe path.

## 5. Why not verify through `server/index.js` or the existing vitest test

- **`server/index.js` is the process entrypoint, not a pure unit.** Importing
  it eagerly initializes deployment-coupled resources: `loadEnvConfig()`
  (line 161) reads `.env`, `db` (line 17) opens SQLite,
  `app.use(express.json(...))` (line 362) constructs Express middleware, and
  `new OpenClawGateway(...)` (line 365) dials the Gateway. It is nevertheless
  the wiring that matters here: `createFileRoutes(app)` at line 1041 mounts
  `server/handlers/files.js`, which reaches the pure resolver at line 112.
- **The existing test file cannot run in this workspace.** It is Vitest-only:
  run `.prale-eval/result.json` → deliverable note; concretely,
  `node --test server/utils/generated-file-path.test.js` fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'`, and
  `npx vitest run …` fails because there is no `node_modules` and dependency
  installation is out of scope. The demo therefore re-expresses the **same
  three assertions** (plus one normalization edge case) against the **same
  source file** using only the Node runtime (v24.14.0).

## 6. Normalized operation result

```
task_id:   T08
repository: wattclaw
mode:      operate
operation: run narrow offline unit verification of a server fixture
command:   node --test .prale-eval/verify-generated-file-path.test.mjs
status:    passed
outcome:   4 passed / 0 failed
runtime:   Node v24.14.0 built-in test runner
deps:      none (no node_modules, no install)
```

## 7. Scope discipline

No repository source, `package.json`, `package-lock.json`, or git configuration
was modified. Only additive files were created under `.prale-eval/`.
