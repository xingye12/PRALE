# Repair: cancellation and completion must fence off late activity

Task: `advanced/execution-lifecycle/retransfer` — repository `earendil-works/pi`.

## Incident reconstruction

Two symptoms, one shape: a lifecycle event (cancellation, completion) had already been
decided, but the code path that publishes work kept running as if the decision had not
been made. Three cooperating modules lost their fence:

| Module | Role in the lifecycle | Defect |
| --- | --- | --- |
| `packages/agent/src/harness/runtime/drive/tools.ts` | tool-batch **scheduler** (sequential/parallel dispatch, recovery of `effect_pending` calls) | `recoverToolInvocation()` accepted a `cancelled` flag from `runParallel()` and then ignored it, so a cancelled recovery took the safe-replay branch: it cleared the durable checkpoint (`clearReplayCheckpoint` deletes `pi.pending.tool_output` and re-publishes `tool_start`) and crossed the effect boundary again (`performToolInvocation`). |
| `packages/agent/src/harness/execution/tools.ts` | tool effect **executor** | `executeToolCall()`'s `finally` block reset `acceptingUpdates` to `true`, so the `onUpdate` closure stayed open after `tool.execute()` settled. A tool that kept a reference to its callback could push live updates and `{checkpoint: true}` updates after completion (and after a throw). |
| `packages/agent/src/harness/execution/effect-gate.ts` | the pass **gate** shared by every admitted effect | `control.beginAbort()` only short-circuited on `status === "aborting"`, so a late abort request re-opened a **closed** gate: `gate.admit()` then threw `AbortRequested` instead of the terminal pass error, and a following `close()` could overwrite the first terminal error. |

The producer/consumer boundaries are what make each defect observable:

* `Lane.requestOperationAbort()` calls `drive.beginAbort(cancellation)` *before* its durable
  command lands, and `reconcileOperation()` calls `drive.beginAbort(...)`/`signalAbort()`
  again while retiring a cancelled leaf. Once the pass has been closed (fault, harness
  close, settlement) those calls must be inert — otherwise every later `drive.gate.admit()`
  (hooks, `before_payload`, deferred polls, tool execution) reports the wrong error.
* `drive/tools.ts` consumes `executeToolCall()` and forwards its updates to two different
  sinks — `publishUpdate` (live `tool_update` events) and `progress.write` (durable
  `pi.pending.tool_output` checkpoint). Both ride the same `onUpdate` closure, so the seal
  belongs in the executor, not in either sink.
* `runParallel()` computes `cancelled` from live control at dispatch time
  (`lane.state.operation.state.control.status === "cancel_requested"`) because a
  cancellation can commit between the batch's initial control check and the per-call
  recovery dispatch. That value is the scheduler's fence.

## Repairs (minimal, API-preserving)

1. `runtime/drive/tools.ts` — `recoverToolInvocation()` now honours `cancelled` first: it
   only *reads* the durable checkpoint (`readCheckpoint`, a pure `lane.command`) and
   publishes the interruption outcome (`interruptedOutcome`, which keeps the checkpoint
   content, `details` and `usage` and appends the "external outcome is unknown" marker).
   It never clears the checkpoint and never invokes the tool. Signature unchanged.
2. `execution/tools.ts` — the `finally` now seals the callback flag
   (`acceptingUpdates = false`), matching the idiom already used by
   `agent-loop.ts:executePreparedToolCall` and `harness/tools/bash.ts`. Callbacks raised
   while the tool is running are still forwarded verbatim; callbacks raised after the tool
   settles (success or throw) are dropped.
3. `execution/effect-gate.ts` — `beginAbort()` only transitions an `open` gate
   (`state.status !== "open"` returns). A closed gate keeps its terminal error for
   `admit()` and for `signal.reason`; `close()` still wins over an in-flight abort, which
   is the intended "completion seals the pass" direction.

Nothing else changes: gate/governance APIs, event shapes, durable addresses and the
sequential cancellation path (`runSequential`'s explicit `cancel_requested` branch) are
untouched.

## Preserved behaviour (non-regression)

* A live (non-cancelled) `safe`/`safe` recovery still replays once with the persisted
  arguments and memos, stages a result that keeps the tool's `details` and `usage`, and
  publishes exactly one `tool_start`, `tool_end`, `message_start`, `message_end` and
  `entry_added`.
* A live unsafe (`never`) recovery still publishes one interrupted outcome that keeps the
  durable checkpoint `details`/`usage`.
* An aborting gate still refuses admission with `AbortRequested(cancellation)` and only
  signals after the durable cancellation; completion still installs the terminal error.

## Local validation

`.prale-eval/regression.mjs` links the real modules through
`.prale-eval/subject.mjs#createGraph` — `session/types.ts`, `session/values.ts`,
`session/commit.ts`, `execution/effect-gate.ts`, `execution/tools.ts`,
`runtime/progress.ts`, `runtime/drive/tool-placement.ts`, `runtime/types.ts` (the real
`Drive`), `runtime/drive/tools.ts` — and fakes only the process boundaries
(`validateToolArguments`, `SessionInvariantError`, `withAbortSignal`/`withoutAbortSignal`)
plus a minimal serialized-mutation lane that records events/commits and serves reads from
an in-memory value store. Asynchronous ordering is driven purely by promises (an async
`toolContext` commits the cancellation at the exact point where the batch dispatch picks up
live control); no timers, randomness or external services are used.

Run from the workspace root:

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

It passes on the repaired tree (8 scenario groups) and, when any one of the three repaired
files is restored to its faulty baseline, fails with a `node:assert/strict` assertion:

* `effect-gate.ts` -> `admit must keep refusing with the terminal gate error`
  (received `AbortRequested`),
* `execution/tools.ts` -> `completion seals both live and checkpoint callbacks` (4 !== 2),
* `runtime/drive/tools.ts` -> `a cancelled recovery never crosses the tool effect boundary`
  (1 !== 0).

No crash, import error or timeout is involved in those detections.
