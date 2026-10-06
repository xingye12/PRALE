# Contract deliverable — ConfigQueue: first job fails, next job still settles

Task: `T02` · Repository: `wattclaw` · Mode: `contract`
Module under contract: `server/core/config-queue.js` (`ConfigQueue`, `configQueueExecute`)

## 1. The contract being pinned

`ConfigQueue` is the single serial FIFO queue through which every Gateway config
modification goes (`server/handlers/channels.js`, `server/handlers/system.js`,
`server/handlers/agent-team.js` all call `configQueueExecute`). The behaviour this
task contracts is the failure-isolation rule of that queue:

1. A job that fails settles **only itself** — its promise rejects.
2. Any job already queued behind it **still gets dequeued and settles**, even though
   it was enqueued *before* the failure happened.
3. The failure does **not** wedge the queue: `_process()` releases `_running` and
   later jobs still run.
4. Settlement values are deterministic and distinguishable:
   * patch + apply success → resolves `undefined`
   * `transformFn` returns falsy (no-op) → resolves `null`, **no** `config.patch` / `config.apply` RPC
   * non-retryable failure → rejects with the original gateway error message, on the first attempt
5. A failed job leaves **no partial configuration** behind (it fails before
   `_recordPatch()` / `config.apply`), so the next job's `config.get` sees a clean state.

## 2. Executable demo

```
node server/core/contract-fixtures/config-queue-failure-settlement.demo.mjs
```

Exit code `0` = contract holds; `1` = assertion failure (the driver prints the failing
assertion). No dependencies, no network, no gateway: plain Node ESM (`node:assert/strict`,
`node:module`, `node:child_process`). Verified on Node v24.14.0.

### Files

| File | Role |
|---|---|
| `server/core/contract-fixtures/config-queue-failure-settlement.demo.mjs` | Fixture + assertions + determinism replay driver |
| `server/core/contract-fixtures/gateway-client-loader.mjs` | ESM `resolve` hook: redirects **only** the `./gateway-client.js` specifier of `server/core/config-queue.js` |
| `server/core/contract-fixtures/gateway-client-stub.mjs` | Deterministic in-memory Gateway (`config.get` / `config.patch` / `config.set` / `config.apply`, OCC `baseHash` checks, scripted one-shot failures, RPC trace) |

The module under contract is imported **unmodified** and never copied or patched. The
hook exists only because `gateway-client.js → multi-tenant-gateway.js` needs runtime
dependencies that are not installed in this checkout (`node_modules` is absent); without
the hook the import fails with `ERR_MODULE_NOT_FOUND` (used as a control, see §4).

### The fixture

Base config (`BASE_CONFIG`): one Feishu account, one model provider and a version marker —
i.e. a small, *different* configuration fixture from the ones the repo's handlers build:

```js
{ channels: { feishu: { accounts: { a1: { appId: 'cli_a1' } } } },
  models:   { providers: { alpha: { id: 'alpha' } } },
  meta:     { version: 1 } }
```

| Scenario | Scripted gateway behaviour | Jobs (enqueued together, before anything settles) | Pinned outcome |
|---|---|---|---|
| **1** `first-job-fails-at-write-next-job-settles` | first `config.patch` fails with `rpc transport closed` (non-retryable) | A `fixture-A-write-fails` (adds account `a2`), B `fixture-B-settles` (bumps `meta.version` to 2) | A → `REJECTED:rpc transport closed`; B → `RESOLVED:undefined`; RPC trace `config.get, config.patch, config.get, config.patch, config.get, config.apply`; `patchCount=1`, `applyCount=1`; final config has `meta.version=2` and **no** account `a2` |
| **2** `first-job-fails-at-read-next-job-settles` | first `config.get` fails with `gateway offline: econnrefused` (non-retryable) | C `fixture-C-read-fails`, D `fixture-D-settles` (adds provider `beta`) | C → `REJECTED:gateway offline: econnrefused`; D → `RESOLVED:undefined`; RPC trace `config.get, config.get, config.patch, config.get, config.apply`; `meta.version` still `1` (C never landed) |
| **3** `queue-still-alive-after-failures` | none | E `fixture-E-noop`, F `fixture-F-noop` (both `transformFn → null`) | both → `RESOLVED:null`; RPC trace `config.get, config.get`; `patchCount=0`; queue drained and live after the two earlier failures |

Every scenario also asserts **FIFO settlement order** (A before B, C before D, E before F) and
that exactly one `config.get` is consumed by a job that fails at the read stage.

### Determinism evidence

Each job is awaited through a 5 s `withTimeout` guard, so a job that would never settle
(the wedge failure mode) fails loudly instead of hanging. The driver then re-runs the
**entire fixture in a fresh child process** (`CONTRACT_REPLAY=1`) and asserts
`deepStrictEqual(childSnapshot, parentSnapshot)`; the printed snapshot contains only
normalized data (settle states, RPC method names, patch/apply counts, final config, hash
labels, unhandled-rejection list) — no timestamps or durations. A `process.on('unhandledRejection')`
collector asserts that the failing jobs leak **zero** unhandled rejections.

## 3. Normalized result (from the passing run)

```json
{
  "first-job-fails-at-write-next-job-settles": {
    "jobA": "REJECTED:rpc transport closed",
    "jobB": "RESOLVED:undefined",
    "calls": ["config.get","config.patch","config.get","config.patch","config.get","config.apply"],
    "gateway": { "patchCount": 1, "applyCount": 1, "hash": "hash-1" }
  },
  "first-job-fails-at-read-next-job-settles": {
    "jobC": "REJECTED:gateway offline: econnrefused",
    "jobD": "RESOLVED:undefined",
    "calls": ["config.get","config.get","config.patch","config.get","config.apply"],
    "gateway": { "patchCount": 1, "applyCount": 1, "hash": "hash-1" }
  },
  "queue-still-alive-after-failures": {
    "jobE": "RESOLVED:null",
    "jobF": "RESOLVED:null",
    "calls": ["config.get","config.get"],
    "gateway": { "patchCount": 0, "applyCount": 0, "hash": "hash-0" }
  },
  "unhandledRejections": [],
  "determinism": { "replay": "identical-snapshot", "comparedAt": "child-process" }
}
```

## 4. Validation

| Command | Status |
|---|---|
| `node server/core/contract-fixtures/config-queue-failure-settlement.demo.mjs` | passed (exit 0, re-run 3× stable) |
| negative control (a): `node -e "import('./server/core/config-queue.js')"` without the loader | `ERR_MODULE_NOT_FOUND` — confirms the loader hook is what makes the fixture runnable here |
| negative control (b): same fixture but the stub fails the **second** job's patch | second job becomes `REJECTED:boom-b` — confirms the "next job still settles" assertions discriminate |

**Limitations recorded (optional validation dependency unavailable):** `node_modules` is not
installed in this checkout, so the devDependency `vitest` and the repository script
`npm run test:server` could not be executed, and the real
`gateway-client.js → multi-tenant-gateway.js` chain could not be loaded (hence the stub, which
is confined to that one import edge). The fixture itself needs no packages, so the contract
above was validated end-to-end with the stock Node binary.

## 5. Source evidence (see `.prale-eval/result.json`)

* `server/core/config-queue.js` — `_process` (L24–37): FIFO drain loop, per-item
  `resolve`/`reject`, `_running` guard released only after the queue empties.
* `server/core/config-queue.js` — `_execute` (L60–100): all errors become
  `{ ok:false, error }` values instead of throws → the drain loop cannot be aborted;
  retry branch limited to OCC / rate-limit messages.
* `server/core/config-queue.js` — `enqueue` (L15–21): pushes the job *with its
  resolve/reject* onto the shared array, so a pre-failure job is still owned and settled.
* `server/core/config-queue.js` — `configQueueExecute` (L104–106): the single shared
  singleton entry point used by every caller, which is what the fixture drives.
