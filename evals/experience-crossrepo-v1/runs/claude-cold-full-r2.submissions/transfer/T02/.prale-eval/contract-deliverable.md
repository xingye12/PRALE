# Contract deliverable — `server/core/config-queue.js`

**Task:** T02 · **Repository:** wattclaw · **Mode:** contract
**Contracted behaviour:** *a configuration fixture where the first job fails and the next job must still settle deterministically.*

## 1. The operation being contracted

`ConfigQueue` is the single FIFO that serialises every Gateway config mutation in
WattClaw. `server/handlers/system.js`, `server/handlers/channels.js` and
`server/handlers/agent-team.js` all reach it through the one exported entry
point, `configQueueExecute` (`server/core/config-queue.js:104-106`), which
forwards to a module-level singleton.

The contract is expressed in terms of *observable settlement*, because that is
all a caller can see:

| # | Guarantee | Where it lives |
|---|---|---|
| G1 | Every enqueued job settles exactly once — `resolve(data)` on success, `reject(error)` on failure. | `enqueue` (`config-queue.js:15-20`) |
| G2 | Jobs are processed strictly serially, in FIFO order; only one drainer runs. | `_process` (`config-queue.js:24-37`) |
| G3 | A failed job does **not** break the drain loop — the next queued job still runs and still settles. | `_process` while-loop (`config-queue.js:27-35`) |
| G4 | The `_running` guard is released once the queue empties, so jobs enqueued *after* a failure are also served. | `_process` (`config-queue.js:36`) |
| G5 | Failure is deterministic: a bounded 3-attempt retry policy, transient errors only, and **every** exit path returns a verdict. | `_execute` (`config-queue.js:60-99`) |

G3 is the load-bearing one for this task. The rejection is delivered inside the
loop (`item.reject(result.error)`, line 33); the loop condition is only
`this._queue.length > 0`, and `this._running = false` sits after the loop rather
than inside a `finally` that a throw could bypass — because `_execute` never
throws. A rejected job therefore leaves no trace that could strand the next one.

G5 is what makes "the first job fails" a *fixture* rather than flakiness.
`_execute` runs `for (let attempt = 0; attempt < maxRetries; attempt++)` with
`maxRetries = 3`. Errors matching `config changed since last load` or
`rate limit` are retried while `attempt < maxRetries - 1`; every other error is
terminal immediately. On the last attempt the retry branch is unreachable, so
the function returns `{ ok: false, error: err }` at line 96 — it cannot fall out
of the loop with `undefined`. The call sequence and the rejection value are
therefore a pure function of the scripted gateway responses.

## 2. The executable fixture

**Run it:**

```bash
node .prale-eval/fixtures/config-queue-first-failure.mjs
```

Exit code `0` means the contract holds; `1` prints the violated assertions.
It emits a JSON report on stdout.

### How it loads the real code

`server/core/gateway-client.js` transitively pulls in the SQLite/Gateway stack,
which is not installed in this environment. Rather than mock the queue, the
fixture uses Node's built-in synchronous module hooks
(`module.registerHooks`, Node v24) to short-circuit **exactly one specifier** —
`server/core/gateway-client.js` — replacing it with a scripted `gatewayAdminRpc`.
The `ConfigQueue` class body that executes in the fixture is the repository's own
source, byte-for-byte unmodified.

```js
registerHooks({
  load (url, context, nextLoad) {
    if (url === GATEWAY_CLIENT_URL) {
      return { format: 'module', shortCircuit: true, source: /* scripted gatewayAdminRpc */ }
    }
    return nextLoad(url, context)
  },
})
```

### Scenario 1 — `terminal-failure-then-success`

The first `config.get` is answered with a terminal error
(`unknown key "alpha" in config`); every later call succeeds.

```
job 1 (first-job)  -> config.get                           -> FAILS, rejected
job 2 (second-job) -> config.get, config.patch, config.get, config.apply -> fulfilled
```

Asserted (7 checks): job 1 is rejected with the gateway's message; job 2 is still
fulfilled; both settle exactly once; the failed job never reached its
`transformFn` (the read failed first, so no mutation was attempted); job 2's
transform received the fetched source config; and the RPC trace is exactly
`config.get,config.get,config.patch,config.get,config.apply`.

### Scenario 2 — `retries-exhausted-then-success`

This is the *different* fixture the task asks for: the first job fails
**through the retry path** rather than on a terminal error. The first three
`config.get` calls return the retryable `config changed since last load`.

```
job 1 -> config.get x3 (attempts 1..3, back-off 2s then 4s) -> rejected
job 2 -> config.get, config.patch, config.get, config.apply  -> fulfilled
job 3 -> config.get, config.patch, config.get, config.apply  -> fulfilled
```

Asserted (7 checks): job 1 rejects after exactly `maxRetries = 3` attempts
(3 failed reads, then the next job's own read/patch/read/apply cycle); the
recorded back-off is exactly `[2000, 4000]` ms; job 2 still settles and settles
once; and **job 3 — enqueued only after job 1 was already rejected — also
settles**, which is the direct evidence for G4 that the drainer did not wedge.

### Determinism

The fixture was run three times: identical status, identical per-scenario RPC
call traces, identical recorded back-off delays. Scenario 2's `setTimeout` is
compressed to `0 ms` so the run takes ~5 ms instead of ~6 s; the delays the
queue *requested* are captured and asserted, so the compression does not weaken
the claim.

## 3. Observed result

```
status:   pass
checks:   14
failures: []
exit:     0
```

| Scenario | ms | RPC trace |
|---|---|---|
| `terminal-failure-then-success` | ~4 | `config.get, config.get, config.patch, config.get, config.apply` |
| `retries-exhausted-then-success` | ~5 | `config.get x4, config.patch, config.get, config.apply, config.get, config.patch, config.get, config.apply` |

## 4. Validation limitation

The repository's own test tooling could not be used: `node_modules` is absent
(so `vitest` cannot resolve) and importing `server/core/gateway-client.js`
fails with `Cannot find package 'better-sqlite3' imported from server/database.js`.
`npm run test:server` was therefore not runnable. The fixture depends only on the
Node standard library (`node:module`, `node:path`, `node:url`) and was executed
with the ambient Node v24.14.0. No repository source file, task metadata,
package lock or git configuration was modified; the only files added are under
`.prale-eval/`.
