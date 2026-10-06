# Contract deliverable — `server/core/config-queue.js`

Task 18 (`wattclaw`, mode `contract`): cover **ordered updates** and **one rejected
configuration action** for the Gateway config mutation queue.

- Module under contract: `server/core/config-queue.js`
- Executable demo: `.prale-eval/config-queue.demo.mjs`
- Validation command: `node .prale-eval/config-queue.demo.mjs` → exit `0`, prints `CONTRACT OK`

## 1. Contract

`configQueueExecute(transformFn, label, method = 'config.patch')` is the only
exported entry point (`server/core/config-queue.js:104-106`). It delegates to the
module-level `ConfigQueue` singleton (`:102`), so **all** config mutations in the
server share one FIFO queue and one 60s / 3-patch rate-limit window.

### Inputs

| Parameter | Meaning |
|---|---|
| `transformFn(sourceConfig)` | Pure-ish transform of the current *fresh* config. Returns the full updated config, or `null` meaning "no change, skip". |
| `label` | Human-readable name used in retry/failure logging. |
| `method` | `'config.patch'` (merge, default) or `'config.set'` (replace, for deletions). |

### Output / normalized operation result

`configQueueExecute` returns a `Promise` that settles when that item is drained:

- **resolve(undefined)** — the update was committed (`config.patch`/`config.set`
  succeeded, then `config.apply` succeeded).
- **resolve(null)** — `transformFn` returned `null`; no mutation was attempted
  (`:69`).
- **reject(Error)** — the action was rejected. Retryable faults (OCC
  `config changed since last load`, or `rate limit`) are retried up to 3 times
  (`:87-93`); every other error is terminal (`:95-96`).

### Guarantees exercised

1. **Ordered updates** — `enqueue` pushes `{transformFn, label, method, resolve,
   reject}` in call order (`:15-20`); `_process` uses the `_running` guard so only
   one drain loop exists, then `shift()`s and `await`s each item in turn
   (`:24-37`). Therefore updates execute FIFO, and each later `transformFn`
   observes the config committed by the previous one.
2. **Single rejected action is isolated** — a terminal Gateway rejection becomes
   `{ ok: false, error }` from `_execute` (`:96`), which `_process` turns into
   `item.reject(error)` (`:33`). It records no patch timestamp (`_recordPatch` at
   `:74` is only reached after a successful mutation, `:56-58`), so it neither
   pollutes the rate-limit window nor stalls subsequent queued items.
3. **Fixed mutation pipeline** — each executed update calls, in order:
   `config.get` → `transformFn` → `_waitForSlot()` → `config.patch|config.set`
   (with `baseHash`) → `config.get` → `config.apply` (`:64-83`).

## 2. Executable demo

`.prale-eval/config-queue.demo.mjs` runs the **real** module. It is dependency-free:

- Node's built-in synchronous module hooks (`module.registerHooks`, Node v24) redirect
  the module's `import { gatewayAdminRpc } from './gateway-client.js'` to an
  in-memory stub, so no live Gateway and no `node_modules` are required.
- The stub implements `config.get` / `config.patch` / `config.set` /
  `config.apply` against a small in-memory `store`, records every call, and
  rejects exactly one action (`update-gamma`, identified by its payload) with a
  message that is neither an OCC conflict nor a rate-limit error.

### Scenario

| Step | Item | Expected normalized outcome |
|---|---|---|
| 1 | `update-alpha` (`alpha=1`) | resolved; committed |
| 2 | `update-beta` (`beta=2`) | resolved; committed; sees `alpha` |
| 3 | `update-gamma` (`gamma=3`) | **rejected** `mutation rejected by gateway policy`; not committed |
| 4 | `update-delta` (`delta=4`) | resolved; queue still draining |

### Observed result (exit 0)

```
[ConfigQueue] update-gamma failed: mutation rejected by gateway policy
CONTRACT OK
  ordered updates : update-alpha -> update-beta -> update-delta committed in FIFO order
  rejected action : update-gamma rejected without committing or stalling the queue
  gateway calls   : 14 ( 14 mutation-lane frames )
```

Normalized gateway call lane asserted by the demo:

```
config.get, config.patch, config.get, config.apply   # update-alpha
config.get, config.patch, config.get, config.apply   # update-beta
config.get, config.patch                             # update-gamma (rejected at patch)
config.get, config.patch, config.get, config.apply   # update-delta
```

Committed store afterwards: `{ channels…, models…, alpha: 1, beta: 2, delta: 4 }`
with no `gamma` key, and the four promises settle in the order
`alpha:resolved, beta:resolved, gamma:rejected, delta:resolved`.

## 3. Validation

- Command: `node .prale-eval/config-queue.demo.mjs`
- Status: **passed** (exit code 0, `CONTRACT OK`), Node v24.14.0.
- Limitation: this checkout has no `node_modules`, so the repository's vitest
  suites (`npm run test:server`) could not be executed; the dependency-free demo
  was used as the focused validation, and no dependencies were installed and no
  files outside `.prale-eval/` were modified.
