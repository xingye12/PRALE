# T21 — Fake-client operation contract (MemoryCore, `tdam`)

## What was requested

Create a fake client operation test that proves **no success state is committed before the
fake effect completes** and that **failure remains observable**.

## Deliverables

| Artifact | Purpose |
| --- | --- |
| `MemoryCore/__tests__/core/fake-client-operation.ts` | Dependency-free contract module + executable demo (`FakeClient`, `CommitOperation`, `runContractChecks()`, `main()`). |
| `MemoryCore/__tests__/core/fake-client-operation.test.ts` | Vitest wrapper (repo runner, `vitest.config.ts` include `__tests__/**/*.test.ts`). |
| `.prale-eval/result.json` | Normalized operation result (task_id/repository/mode, evidence, claims, conclusion, validation). |

No production source, task metadata, oracle file, package lock, or git configuration was modified.

## The contract

The public surface of `MemoryCore/src/core/index.ts` re-exports the `TdaiCore` facade (line 25)
and `StorePool` / `PooledStore` (lines 44-45). Their lifecycle establishes the contract this test
pins down:

1. **No success before the effect completes.** An operation may enter a *pending* state
   immediately, but a *success/ready* state (and any committed record) may be written only in the
   branch that runs **after** the asynchronous effect has actually completed.
2. **Failure stays observable.** If the effect rejects, the caller must observe the rejection, the
   failure must be recorded rather than converted into success, and no success state may be
   committed. The in-flight gate is cleared so a later retry can run.

The production reference is `TdaiCore`'s promise-gate (`schedulerStartPromise` / `storeReady`,
`MemoryCore/src/core/tdai-core.ts:160-179`), whose own doc comment names the anti-pattern — a
boolean flag that is "flipped to `true` *before* the await completes". The counter-example is
`StorePool.getStore` (`MemoryCore/src/core/store/store-pool.ts:171-221`), which publishes the pooled
store into the pool at line 200 **before** `await store.init()` at line 215 and swallows the
initialisation failure with a log warning at line 217.

## The executable demo / normalized operation result

`FakeClient.operation(id)` returns a promise that resolves only when the test settles the
corresponding gate, then records the effect in `applied`. `CommitOperation.commit(id)` mirrors the
`TdaiCore` gate:

- first call publishes the in-flight promise and sets `status = "pending"`;
- concurrent calls join the same in-flight effect (the fake client is invoked once);
- the resolved branch increments `committed` and sets `status = "ready"`;
- the rejected branch sets `status = "failed"`, stores `lastError`, clears the gate, and re-throws.

`runContractChecks()` returns a normalized list of `{ name, detail }` results and throws on any
violation.

### Observed run

```
$ cd MemoryCore
$ node --experimental-strip-types __tests__/core/fake-client-operation.ts
PASS no-success-committed-before-effect — status=pending, committed=0, applied=0
PASS concurrent-caller-shares-inflight-effect — second commit started no new effect and committed nothing
PASS success-committed-only-after-effect — status=ready, committed=1, applied=[mem-1]
PASS failure-observable-and-not-committed — status=failed, committed=0, lastError="backend refused"
PASS failure-leaves-gate-clear-for-retry — committed=1 after retry
OK 5 contract checks passed
```

| Check | Property proved |
| --- | --- |
| `no-success-committed-before-effect` | While the fake effect is in flight, `status="pending"`, `committed=0`, `applied=[]`. |
| `concurrent-caller-shares-inflight-effect` | A second call joins the in-flight effect (`calls` stays 1) and still commits nothing. |
| `success-committed-only-after-effect` | Success (`ready`, `committed=1`, effect applied) appears only after the effect resolves. |
| `failure-observable-and-not-committed` | Rejection reaches the caller, `status="failed"`, `lastError` set, `committed=0`, effect not applied. |
| `failure-leaves-gate-clear-for-retry` | After failure the gate is cleared, so a retry starts a fresh effect and commits once. |

## Validation

- **Command:** `node --experimental-strip-types __tests__/core/fake-client-operation.ts`
  (run from `MemoryCore/`) — **status: pass**, exit 0.
- Both files pass `node --experimental-strip-types --check`.
- **Limitation:** vitest is the repo's declared runner but is not installed in this fixture (no
  `node_modules`; installing dependencies is out of scope), so
  `npx --no-install vitest run __tests__/core/fake-client-operation.test.ts` fails with
  `ERR_MODULE_NOT_FOUND` for the vitest CLI. The demo entry point executes the *same*
  `runContractChecks()` assertion body under Node's native TypeScript support, so the contract is
  executed and verified without the unavailable dependency.
