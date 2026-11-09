# Repair: lifecycle fences across scheduler, executor and gate

## Incident

Two producer/consumer leaks shared one root cause: a lifecycle owner that announces
"this is over" (cancellation or completion) was not consulted by the code that was
still allowed to produce effects, updates or state transitions.

1. `recoverToolInvocation` (`packages/agent/src/harness/runtime/drive/tools.ts`) received a
   `cancelled` flag from the scheduler but never read it. A `replay: "safe"` persisted call
   whose tool also declared `replay: "safe"` still ran `clearReplayCheckpoint` (deleting the
   durable progress snapshot and emitting a live `tool_start`) and then re-crossed the external
   effect boundary through `performToolInvocation`. A cancelled recovery therefore executed the
   tool a second time.
2. `executeToolCall` (`packages/agent/src/harness/execution/tools.ts`) opened the live update
   channel with `let acceptingUpdates = true` and then, in `finally`, reset it to `true` instead
   of closing it. Settlement never sealed the channel, so a callback captured by the tool kept
   producing `tool_update` events — and, because the drive-level callback forwards
   `{ checkpoint: true }` updates to `progress.write`, kept producing new checkpoints after the
   invocation had already been finalized and staged.
3. `createGate().control.beginAbort` (`packages/agent/src/harness/execution/effect-gate.ts`)
   only refused to act while the gate was already `aborting`. Against a `closed` gate it
   overwrote the terminal `{ status: "closed", error }` state with `{ status: "aborting" }`,
   which both reopened admission (subsequent `admit` threw a fresh `AbortRequested` instead of
   the terminal error) and replaced the terminal signal reason.

## Fix

Three one-line state-transition guards, each in its own module, no API changes:

- **Gate** — `beginAbort` now returns unless the gate is still `open`, so `closed` is strictly
  terminal: `admit` keeps rethrowing the original error and `signal.reason` keeps the terminal
  error. `beginAbort` on `aborting` still keeps the first cancellation promise, and
  `signalAbort` still only signals durable cancellation.
- **Executor** — the `finally` around `tool.execute` sets `acceptingUpdates = false`, so the
  update callback handed to the tool is sealed exactly when the effect settles. Updates emitted
  during execution still flow; anything emitted afterwards is dropped, which also stops
  post-completion checkpoint writes because the drive only writes a checkpoint after the
  executor has forwarded the update.
- **Scheduler** — `recoverToolInvocation` only takes the safe-replay path when `!cancelled`.
  A cancelled recovery skips `clearReplayCheckpoint` and `performToolInvocation` entirely and
  falls through to `readCheckpoint` + `publishToolOutcome(interruptedOutcome(...))`, the same
  terminal path `runSequential` already used for `cancel_requested` runs: one published outcome,
  durable checkpoint content/details preserved, interruption marker appended, no effect.

The fence is one-way in each case: completion/cancellation latches a terminal state, and no
later event can move it back to an active one.

## Cross-module flow after the fix

`drive/tools.ts` (scheduler) decides whether an effect may be re-admitted → `execution/tools.ts`
(executor) admits it through the gate and forwards live/checkpoint updates only while the effect
is live → `execution/effect-gate.ts` (gate) decides admission vs. terminal refusal. The
scheduler's `cancelled` decision no longer depends on the gate being asked, and the executor's
seal guarantees the scheduler can never receive a second update or checkpoint for a finalized
call.

Non-cancelled `safe`/`safe` recovery is unchanged: checkpoint cleared, persisted arguments used,
tool invoked once, `details`/`usage` preserved through `finalizeToolCall` /
`createToolResultMessage`, exactly one publication.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` loads the real modules through
`.prale-eval/subject.mjs` (only checkpoint storage, progress transport and hook delivery are
faked) and asserts:

- cancelled `safe`/`safe` recovery: no `clear`, no `invoke`, no `update`, no `checkpoint`, one
  `read`, one `publish`, checkpoint content/details preserved, interruption marker present;
- non-cancelled `safe`/`safe` recovery: `clear` → `invoke` → `publish` once, one checkpoint,
  recovered content/details/usage preserved;
- executor directly: live update forwarded while running, late update dropped after settlement;
- end-to-end: no `tool_update` and no `progress.write` after a completed invocation;
- gate: `close` then `beginAbort` keeps the terminal error (admission and signal reason), while
  `beginAbort` on an open gate still raises `AbortRequested` with the same cancellation promise.

Mutation check (each file restored alone to its faulty baseline, run in-place, then repaired
again):

| file reverted | observed failure |
| --- | --- |
| `runtime/drive/tools.ts` | `cancelled recovery must not cross the external effect boundary` |
| `execution/tools.ts` | `updates emitted after completion are dropped by the executor seal` |
| `execution/effect-gate.ts` | `a closed gate keeps rejecting with its terminal error` |

All three are assertion failures, not crashes or import errors, and the repaired tree passes.

## Limitations

- The repository's vitest suites under `packages/agent/test/harness/` were not executed: the
  workspace has no installed `node_modules` and dependency installation is out of scope for this
  task. The regression script is self-contained (Node 24 only) and exercises the same modules.
- No temporary fixtures are needed; the script writes nothing, so nothing is left to clean up
  beyond the `.prale-eval/` artifacts.
