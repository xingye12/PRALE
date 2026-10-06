# T21 — Contract deliverable: fake client operation commit ordering (MemoryCore)

Repository: `tdam` · Mode: `contract` · Task: `T21`

## 1. What was delivered

| Artifact | Purpose |
| --- | --- |
| `MemoryCore/src/core/__tests__/fake-client-operation.contract.test.ts` | Executable contract test (fake client operation) |
| `.prale-eval/contract-deliverable.md` | This document: contract, normalized operation result, run instructions |
| `.prale-eval/result.json` | Machine-readable evidence, claims, conclusion, validation |

No other file was modified. Task metadata, hidden-oracle files, package locks and git configuration were left untouched.

## 2. Contract

MemoryCore's public core surface (`MemoryCore/src/core/index.ts`) hands callers an
**async operation whose resolved promise is the success signal**: `TdaiCore` is re-exported at
line 25, and its effect-performing methods (`handleTurnCommitted` → `performAutoCapture`) return
only after the underlying effect completed. `SkillAssetHooks` (`MemoryCore/src/core/tdai-core.ts:86-91`)
fixes the same rule for asset registration — *"onSkillCreated: v1 awaits it first; throwing = create
failure"* — and `SkillVersioning.createNewSkill` (`MemoryCore/src/core/skill/skill-versioning.ts:117-205`)
enforces it: it awaits `onSkillCreated` (line 174), rolls back and rethrows `assetErr` on failure
(line 198), and only reaches `onSkillVdbChanged?.(1); return row;` (lines 202-204) once every effect
succeeded.

The contract asserted by the new test:

1. **No success state before the effect completes.** While the fake effect is in flight, the
   operation is `status === "pending"`, the committed-success list is empty, no `commit:success`
   event exists, and the operation promise has not settled — verified after real timer time
   (20 ms), not merely one microtask.
2. **Commit strictly after effect completion.** The `commit:success` event index is greater than
   the `effect:completed` event index, and exactly one committed record exists.
3. **Failure stays observable.** A rejecting effect makes the returned promise reject with the
   original error, records `failure = { message, code }`, keeps `committed` empty and adds
   `effect:failed`; the failure is never converted into a success.
4. **Failures are recoverable, not sticky-as-success.** The same operation can be retried after a
   failure; the retry does not inherit a stale success, and only the retry's own effect receipt is
   committed.
5. **The test discriminates.** A control subject (`runEagerCommit`) commits optimistically before
   awaiting the effect; the same probes that pass for the contract implementation fail for it.

## 3. Normalized operation result

The test normalizes every operation into one observable structure, so "success committed" is a
single, checkable fact:

```ts
export type OperationStatus = "idle" | "pending" | "succeeded" | "failed";

export interface CommittedRecord { effectId: string; payload: string }
export interface ObservableFailure { message: string; code?: string }

export interface OperationState {
  status: OperationStatus;             // pending until the effect settles
  committed: CommittedRecord[];        // success state — empty while in flight
  failure: ObservableFailure | null;   // last observable failure, never merged into success
  events: string[];                    // ordered trace: op:start, effect:completed, commit:success, effect:failed
}
```

Fake client: `FakeMemoryCoreClient.performEffect(payload)` returns a promise that **never settles on
its own**; the test drives it with `completeEffect(...)` / `failEffect(...)`. That deferred effect is
what exposes the window between "operation started" and "effect done" in which an optimistic
implementation would wrongly commit. `inFlightCount` records effects started but not yet settled.

Subjects:

* `runCommitAfterEffect` — the contract shape (mirrors `TdaiCore.handleTurnCommitted` /
  `SkillVersioning.createNewSkill`).
* `runEagerCommit` — the anti-pattern control used to prove the assertions are not vacuous.

## 4. Executable demo / how to run

Third-party dependencies are **not installed** in this workspace (`MemoryCore/node_modules` is
absent), so the repository's configured runner (`npm test` → `vitest run`, see
`MemoryCore/vitest.config.ts`, which includes `src/**/*.test.ts`) cannot execute here:

```
$ cd MemoryCore && npm test -- --run src/core/__tests__/fake-client-operation.contract.test.ts
sh: 1: vitest: not found
```

The contract test is therefore dependency-free and uses Node's built-in test runner:

```
node --test MemoryCore/src/core/__tests__/fake-client-operation.contract.test.ts
```

Observed result (Node v24.14.0):

```
✔ no success state is committed while the fake effect is still in flight (22.9ms)
✔ success is committed after (never before) the effect completes (21.3ms)
✔ effect failure is observable and never becomes a committed success (21.1ms)
✔ an observable failure can be retried without leaking stale success (43.0ms)
✔ control: an eager-commit implementation fails the same assertions (22.9ms)
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

Discrimination check (mutation, run on a scratch copy outside the deliverable): making
`runCommitAfterEffect` commit before awaiting the effect made **all 5 tests fail** (`pass 0 / fail 5`),
so the suite genuinely detects premature commits rather than passing unconditionally.

## 5. Repository grounding (evidence)

* `MemoryCore/src/core/index.ts:24-26` — `TdaiCore` re-export: the facade callers use; async
  method resolution is the success signal the contract pins down.
* `MemoryCore/src/core/index.ts:50-61` — `LocalStorageBackend` / `StoragePaths` / `StorageAdapter` /
  `createStorageBackend`: MemoryCore already treats storage as an injectable seam, which is why a
  fake client/backend needs no network or cloud credentials.
* `MemoryCore/src/core/tdai-core.ts:86-112` — `SkillAssetHooks`: documents the effect-first rule.
* `MemoryCore/src/core/skill/skill-versioning.ts:117-205` — `createNewSkill`: the awaited effect
  (line 174), compensating rollback with rethrow (line 198), success return (lines 202-204).

## 6. Limitations

* `vitest` (the repository's configured test runner) is unavailable offline in this workspace; the
  suite was executed with `node --test` instead, and is written without any third-party import so
  the same file runs unchanged wherever vitest exists (only the runner entry point differs).
* The test exercises a normalized in-memory stand-in for MemoryCore's external effects (COS write /
  `meta_assets` registration), because the real `TdaiCore` graph requires uninstalled runtime
  dependencies (`zod`, `ai`, `sqlite-vec`, …). The ordering contract it asserts is the one the
  cited core files document and implement.
