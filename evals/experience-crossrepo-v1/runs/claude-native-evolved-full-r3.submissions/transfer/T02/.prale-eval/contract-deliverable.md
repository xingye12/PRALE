# Contract deliverable — ConfigQueue failure isolation (T02)

Repository: `wattclaw` · Mode: `contract` · Task: `T02`

## 1. What is being contracted

`server/core/config-queue.js` serializes every Gateway configuration
modification through a single `ConfigQueue` singleton. The contract this task
fixtures is **failure isolation with deterministic settlement**:

> If the **first** queued configuration job fails, the **next** queued job must
> still execute and settle, and the queue must not remain wedged — a subsequent
> job must still settle too.

The contract is expressed as an executable fixture rather than prose, so it can
be re-run and its result is reproducible.

## 2. Executable demo

**Artifact:** `.prale-eval/config-queue-failure-isolation.test.mjs`

**Run:**

```bash
node --test .prale-eval/config-queue-failure-isolation.test.mjs
```

**Self-containment.** The repository's `node_modules` is not installed, so the
fixture deliberately depends only on Node built-ins (`node:test`,
`node:assert/strict`, `node:module`). `config-queue.js` statically imports
`gatewayAdminRpc` from `./gateway-client.js`, whose real import chain reaches
`better-sqlite3` and would fail to resolve without dependencies. The fixture
installs a synchronous resolve hook (`module.registerHooks`) that rewrites the
`./gateway-client.js` specifier to an inline `data:` URL module. That stub
forwards to a test-controlled function, so the **unmodified production
`ConfigQueue` class** is what actually runs under test.

**Fixture shape.** It is a *failing-first* configuration fixture: the scripted
gateway behaves normally (`config.get` succeeds, `config.apply` succeeds) but
returns `{ ok: false, error: 'fixture: first job failed' }` on the **first**
`config.patch` call only. Every later patch succeeds. This differs from a
happy-path fixture precisely in that the first job is forced to fail.

### Scenario 1 — first job fails, next job still settles

1. Enqueue `job-A` (will fail) then `job-B` (will succeed), synchronously, in
   that order.
2. `await Promise.allSettled([jobA, jobB])`.
3. Assert `job-A` is `rejected` and its error message is preserved.
4. Assert `job-B` is `fulfilled` (value `undefined`).
5. Enqueue `job-C`; assert it also settles — proof the queue did not wedge.
6. Assert the exact serial call order:
   `config.get, config.patch` (A fails here) then the full
   `config.get, config.patch, config.get, config.apply` cycle for B and C.

### Scenario 2 — deterministic across repeated runs

The failing-first scenario is repeated three times. Each iteration imports the
queue with a unique query string (`?fixture-run=N`) so it gets a **fresh
`ConfigQueue` instance** — rate-limit state from a prior run cannot leak in.
All three runs must produce the identical normalized outcome
(`rejected` / `fulfilled` / `undefined`) with the same success call sequence.

### Validation record

| Field | Value |
| --- | --- |
| Command | `node --test .prale-eval/config-queue-failure-isolation.test.mjs` |
| Status | **passed** |
| Runtime | Node v24.14.0 (repository runtime), no packages installed |
| Result | `tests 2, pass 2, fail 0` |

## 3. Normalized operation result

Given the failing-first fixture, the normalized outcome of submitting
`[A (fails), B (succeeds)]` is:

```
[ PromiseSettledResult { status: 'rejected',  reason: Error('fixture: first job failed') },
  PromiseSettledResult { status: 'fulfilled', value: undefined } ]
```

i.e. fail-then-settle, with both promises settled and the queue length
returning to zero. A follow-up job settles normally.

## 4. Why the production code guarantees this (cited behavior)

- `ConfigQueue._process` (`server/core/config-queue.js:24-37`) drains the queue
  in a `while` loop, `await`s `_execute(item)`, and on a non-ok result calls
  `item.reject(result.error)` — a plain return, not a `throw`, so the loop is
  not aborted and the next job is shifted and executed.
- `ConfigQueue._execute` (`server/core/config-queue.js:60-99`) turns gateway
  RPC failures into a returned `{ ok: false, error }` for non-retryable errors
  (and once retries are exhausted), keeping the failure scoped to one item.
- `ConfigQueue.enqueue` (`server/core/config-queue.js:15-20`) gives every job
  its own `resolve`/`reject` pair, so one job's rejection cannot settle
  another job's promise.
- `ConfigQueue._recordPatch` (`server/core/config-queue.js:56-58`) is called
  only after a successful `config.patch` (line 74), so the failed first job
  consumes no rate-limit slot and cannot delay the jobs behind it.

## 5. Scope of changes

Added only evaluation artifacts under `.prale-eval/` (this document, the
fixture, and `result.json`). No production source, task metadata, oracle files,
package locks, or git configuration were modified.
