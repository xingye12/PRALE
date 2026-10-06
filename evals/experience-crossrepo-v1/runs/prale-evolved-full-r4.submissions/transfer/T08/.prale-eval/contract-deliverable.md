# Contract deliverable — ConfigQueue failure-ordering fixture (T08)

Repository: `wattclaw` · Task mode: `contract` · Batch key: `wattclaw`

## 1. What is contracted

The behaviour under contract is the ConfigQueue failure-isolation guarantee of
`server/core/config-queue.js`:

> **If the first queued configuration job fails, the next queued job must still be
> executed and must settle deterministically against the configuration state that
> the failed job never mutated.**

Two mechanisms in the source provide this, and the fixture makes both observable:

| Mechanism | Source | Contracted effect |
| --- | --- | --- |
| Failure-isolated FIFO drain | `ConfigQueue._process` (`server/core/config-queue.js:24-37`) | `_running` single-flight guard; the `while` loop `shift()`s one job per iteration and either `item.resolve(result.data)` or `item.reject(result.error)`; a rejection does **not** break the loop, and `_running` is released only after the queue is empty. |
| Per-job read→transform→write→apply chain with selective retry | `ConfigQueue._execute` (`server/core/config-queue.js:60-99`) | `config.get` → `transformFn(sourceConfig)` → `_waitForSlot()` → `config.patch` (with the fresh `baseHash`) → `_recordPatch()` → `config.get` → `config.apply`. Only `config changed since last load` and `rate limit` errors are retried (`isOcc` / `isRateLimit`, lines 84-97); every other failure returns `{ ok: false, error }` on the first attempt. |

Because the failing job aborts **before** any accepted patch is recorded or applied,
the gateway config document and its hash are unchanged, so the next job's `config.get`
returns the same `baseHash` and its own patch/apply chain succeeds. That is the
determinism claim: the next job's outcome depends only on the untouched fixture state,
not on how or when the first job failed.

## 2. The different configuration fixture

`/.prale-eval/config-queue-failure-fixture.mjs` is the executable fixture. It differs
from a transform-level rejection fixture: failure is injected at the **Gateway /
configuration layer** through a scripted in-memory config document, and two distinct
first-job failure points are contracted.

The harness loads the **real** `server/core/config-queue.js`; only the single
`import { gatewayAdminRpc } from './gateway-client.js'` specifier is rebound to the
injected stub (via a `data:` URL module) so the fixture runs without `node_modules`.
The unmodified `enqueue`, `_process`, `_execute`, `_waitForSlot`, `_recordPatch` and
`configQueueExecute` code paths execute.

### Fixture A — `get-fails-first`

Scripted config document: `{ agents: { main: { name: 'main' } }, gateway: { logLevel: 'info' }, bindings: [] }`, hash `hash-s1-1`.

1. **job 1** (`fail-at-get`, transform `logLevel: 'warn'`) — its first `config.get`
   returns `{ ok: false, error: 'gateway transport offline (fixture)' }`, a
   non-retryable error. `_execute` throws at line 65, the catch gate does not match
   `isOcc`/`isRateLimit`, and the promise rejects after a single attempt. No
   transform, no `config.patch`, no `config.apply`.
2. **job 2** (`settle-after`, transform `logLevel: 'debug'`) — reads the untouched
   document (`baseHash: 'hash-s1-1'`), patches, re-reads and applies, resolving
   `undefined`.

Expected normalized operation result:

```
trace          config.get:fail, config.get:ok, config.patch:ok, config.get:ok, config.apply:ok
first job      rejected: 'gateway transport offline (fixture)'
next job       resolved: undefined
queue length   0 (drained)
config.patch   1 call, baseHash hash-s1-1
config.apply   1 call
final config   gateway.logLevel = 'debug'
```

### Fixture B — `patch-fails-first`

Scripted config document: `{ agents: { main: { name: 'main' } }, gateway: { logLevel: 'info' }, bindings: [] }`, hash `hash-s2-1`.

1. **job 1** (`fail-at-patch`, transform `logLevel: 'trace'`) — reads and transforms
   successfully, but its `config.patch` returns
   `{ ok: false, error: 'config.patch rejected: invalid logLevel (fixture)' }`.
   `_execute` throws at line 73 before `_recordPatch()` / `config.apply`, so the
   promise rejects and the document keeps hash `hash-s2-1`.
2. **job 2** (`settle-after`, transform `logLevel: 'debug'`) — still reads
   `hash-s2-1`, patches, re-reads and applies, resolving `undefined`.

Expected normalized operation result:

```
trace          config.get:ok, config.patch:fail, config.get:ok, config.patch:ok, config.get:ok, config.apply:ok
first job      rejected: 'config.patch rejected: invalid logLevel (fixture)'
next job       resolved: undefined
queue length   0 (drained)
config.patch   2 calls, baseHashes hash-s2-1, hash-s2-1   <-- failing job left the hash untouched
config.apply   1 call (next job only)
final config   gateway.logLevel = 'debug'
```

## 3. Determinism check

`main()` replays each fixture `REPEATS = 30` times (60 runs total) with a fresh
`ConfigQueue` and a fresh scripted gateway per run, and requires a **single distinct
JSON signature** across replays — covering per-job status/error, the next job's
outcome, drained queue length, call trace, patch/apply counts, patch base hashes and
the final config — in addition to the per-check expectations. No wall-clock waits are
involved: fewer than `_MAX_PATCHES` patches per run means `_waitForSlot` never sleeps,
and the injected errors are non-retryable so `_execute` never backs off.

## 4. How to run it

```
node .prale-eval/config-queue-failure-fixture.mjs     # fixture -> exit 0, "[fixture] ALL CHECKS PASSED"
node .prale-eval/validate-result.mjs                  # result.json / citation checks -> "ALL RESULT CHECKS PASSED"
node --check .prale-eval/config-queue-failure-fixture.mjs
```

Observed output: `[fixture] get-fails-first: PASS (30/30 identical runs; first job
rejected, next job settled)` and `[fixture] patch-fails-first: PASS (30/30 identical
runs; first job rejected, next job settled)`, then `[fixture] ALL CHECKS PASSED`,
exit code 0.

## 5. Validation limitation

`node_modules` and the `vitest` runner are absent from this workspace, so the
repository's official test suite could not be executed and no dependency was
installed. The substitute evidence is (a) the fixture, which executes the real
`ConfigQueue` source against a scripted gateway, and (b) `.prale-eval/validate-result.mjs`,
which statically re-verifies the result metadata, every evidence symbol/line-range
citation and claim grounding. These are lower strength than the full test suite and
are recorded as such in `result.json.validation.notes`.

## 6. Files

| File | Role |
| --- | --- |
| `.prale-eval/result.json` | Contract result: metadata, evidence citations, claims, conclusion, validation. |
| `.prale-eval/config-queue-failure-fixture.mjs` | Executable configuration fixture and determinism harness. |
| `.prale-eval/validate-result.mjs` | Focused static validation of the result artifact. |
| `.prale-eval/contract-deliverable.md` | This document. |

No task metadata, hidden-oracle file, package lock or git configuration was modified;
the only added files are the four above.
