# T14 · Cross-repository experience transfer — contract deliverable

- **Repository key:** `tdam`
- **Task mode:** `contract`
- **Request:** *Evaluate in MemoryCore — create a fake client operation test that proves no success state is committed before the fake effect completes and failure remains observable.*
- **Deliverables:** executable demo (`.prale-eval/contract/fake-client-operation.test.mjs`), this contract description, `.prale-eval/result.json`, and the focused validator `.prale-eval/verify-citations.mjs`.

---

## 1. The contract (what must be true)

For any client operation that fronts a real side effect — a store/connection write, a credential
fetch, a scheduler start — two properties must hold:

1. **Commit-after-effect.** The operation's success state (a cached value, a `started` sentinel, a
   "done" flag) must be written **only after the awaited effect settles successfully**. While the
   effect is pending, an observer must see `pending`, never `success`. A plain boolean flipped
   before the `await` is *not* sufficient; the ordering must be enforced by the effect's own
   promise.
2. **Failure is observable.** A failed effect must never be laundered into a success. The original
   error must propagate to the caller (or be recorded), the success state must stay unset, and any
   in-flight gate must be cleared so a later retry is possible.

Two corollaries fall out of these and are also asserted: concurrent callers should coalesce onto a
**single** effect invocation and a **single** commit, and a legitimate stale/fallback read must be
distinguishable from a fresh success.

## 2. Where MemoryCore already encodes this contract

| Location | Symbol | Why it is the contract |
|---|---|---|
| `MemoryCore/src/core/index.ts:25` | `TdaiCore` | Public barrel entry surface for the core facade; the operation contract is reached through it. |
| `MemoryCore/src/core/index.ts:56-58` | `MockCredentialProvider`, `CachedCredentialProvider` | The `fake` client and the real commit-after-effect client are both re-exported here. |
| `MemoryCore/src/core/tdai-core.ts:160-178` | `schedulerStartPromise` | Doc + field: a plain boolean is unsafe because it flips *before* the await; the in-flight promise is the success sentinel. |
| `MemoryCore/src/core/tdai-core.ts:1187-1217` | `ensureSchedulerStarted` | Coalesces concurrent callers on one promise; the async body awaits checkpoint-read + `scheduler.start`; `.catch` clears the gate on failure. |
| `MemoryCore/src/core/tdai-core.ts:408-414` | `handleTurnCommitted` | `await this.storeReady` then `await this.ensureSchedulerStarted()` **before** `performAutoCapture`, so no capture is committed before the effect is ready. |
| `MemoryCore/src/core/storage/credential-provider.ts:30-51` | `MockCredentialProvider` | The deterministic fake client: fixed credentials, no async effect, no hidden state. |
| `MemoryCore/src/core/storage/credential-provider.ts:105-120` | `CachedCredentialProvider.getCosCredential` | One shared in-flight `this.fetchPromise`, cleared in `finally`; pending effect never yields a success value. |
| `MemoryCore/src/core/storage/credential-provider.ts:150-167` | `CachedCredentialProvider.refresh` | Commit point `this.cached = credential` happens **after** `await this.fetcher()`; on failure it warns + serves the prior value only if one exists, otherwise **re-throws**. |

## 3. The executable demo

`node .prale-eval/contract/fake-client-operation.test.mjs` (dependency-free, plain Node ESM) models
the two cited shapes and asserts the contract directly:

- `OperationGate` mirrors `TdaiCore.ensureSchedulerStarted()` — one shared in-flight promise; the
  `committed` counter and `done` state are touched only inside the closure that follows
  `await this._effect()`; the `.catch` records the failure and clears the gate.
- `CoalescingFakeClient` mirrors `CachedCredentialProvider.getCosCredential()` / `refresh()` — a
  controllable `FakeEffect` supplies the side effect; `cached` is assigned only after the awaited
  fetch resolves; a failure with no stale value is re-thrown.

### Normalized operation result (observed, exit 0)

```json
{
  "task": "T14",
  "repository": "tdam",
  "summary": { "total": 7, "passed": 7, "failed": 0 },
  "cases": [
    { "case": "no_success_committed_while_effect_pending",              "events": ["effect:start", "commit"], "pass": true },
    { "case": "commit_ordering_is_effect_then_success",                 "events": ["effect:start", "success-committed"], "pass": true },
    { "case": "concurrent_callers_share_one_effect_and_one_commit",     "events": ["effect:start", "effect:invoked", "effect:coalesced", "effect:coalesced", "effect:coalesced", "effect:coalesced", "commit"], "pass": true },
    { "case": "failure_is_observable_and_never_committed",              "events": ["effect:start"], "pass": true },
    { "case": "coalescing_client_reraises_failure_when_no_stale_cache", "events": ["effect:start", "effect:invoked", "failure:observable"], "pass": true },
    { "case": "gate_clears_after_failure_so_retry_can_succeed",         "events": ["effect:attempt:1", "effect:attempt:2", "commit"], "pass": true },
    { "case": "stale_cache_fallback_stays_observable",                  "events": ["effect:start", "effect:invoked", "commit", "effect:start", "effect:invoked", "stale:fallback"], "pass": true }
  ]
}
```

Interpretation of the ordered event logs (the proof):

- **No premature commit:** in `no_success_committed_while_effect_pending`, after the gate is started
  and the microtask queue is flushed, the effect is still pending, `gate.state === "pending"`,
  `gate.committed === 0`, and the only event is `effect:start`. The `commit` event appears only
  after `effect.complete(...)`.
- **Strict ordering:** `commit_ordering_is_effect_then_success` asserts `effect:start` precedes
  `success-committed`.
- **Coalescing:** five concurrent `get()` calls produce **one** `effect:invoked`, four
  `effect:coalesced`, and exactly **one** `commit`.
- **Observable failure:** the failing effect produces no `commit` event; `assert.rejects` confirms
  the *original* error object propagates, and `committed === 0`.
- **Retry after failure:** the gate cleared by failure lets a second attempt succeed and commit —
  events `effect:attempt:1`, `effect:attempt:2`, `commit` (only the success commits).
- **Stale fallback ≠ fresh success:** when the committed value is stale and refresh fails, the demo
  emits `stale:fallback` (and logs a warning) without incrementing `commitCount` — the failure stays
  observable instead of becoming a silent re-commit.

## 4. How to validate

```bash
node .prale-eval/contract/fake-client-operation.test.mjs   # demo: exits 0, 7/7 cases pass
node .prale-eval/verify-citations.mjs                      # citations vs TASK.md + live checkout
```

`verify-citations.mjs` re-reads `TASK.md` and `result.json`, confirms `task_id`/`repository`/`mode`
match the task metadata, confirms the required path `MemoryCore/src/core/index.ts` is cited, checks
that **every** named symbol occurs inside its inclusive `start_line`/`end_line` window in the live
file, and that every claim names at least one existing evidence path.

## 5. Limitations (recorded, not worked around)

- This checkout ships **no `node_modules`**, and this session must not install dependencies. The
  TypeScript sources therefore could not be imported/executed directly: Node's strip-only mode
  rejects the parameter properties in `credential-provider.ts`, and the sources' `.js` specifiers do
  not resolve without a loader/build. The contract is demonstrated by a dependency-free model of the
  **cited** semantics plus a programmatic citation check, not by a runtime import of the real modules.
- The demo models the behavior; it does not claim to test unrelated MemoryCore paths.
- No task metadata, hidden-oracle file, package lock, or git configuration was modified.
