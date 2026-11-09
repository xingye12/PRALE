# Lifecycle fences across scheduler, executor and gate

The incident had three coupled lifecycle leaks. Each leak lives in a different
module, and each is observable only through a module boundary, so the repair
touches one line per file while the regression exercises all three together.

## 1. Scheduler: a cancelled recovery replayed the effect

`packages/agent/src/harness/runtime/drive/tools.ts`

`runParallel` computes whether the durable operation is already
`cancel_requested` and hands that flag to `recoverToolInvocation(..., cancelled)`.
The parameter was accepted but never consulted, so the `replay === "safe" &&
tool.replay === "safe"` branch still called `clearReplayCheckpoint` (deleting the
durable progress checkpoint and re-reading persisted arguments) and then
`performToolInvocation` (re-invoking the external effect) even though the
operation had been cancelled.

Repair: the safe/safe replay branch is now guarded by `!cancelled`. A cancelled
recovery falls through to the existing interruption path - read the durable
checkpoint and publish exactly one interrupted outcome. It never clears the
checkpoint and never invokes the tool. The non-cancelled safe/safe path is
untouched, so persisted arguments, details and usage still flow through
`finalizeToolCall`/`createToolResultMessage` and the outcome is published once.
This matches the sequential cancellation branch, which already read the
checkpoint and published an interrupted (non-terminating) result.

## 2. Executor: a completed tool kept accepting live updates

`packages/agent/src/harness/execution/tools.ts`

`executeToolCall` wraps the tool's update callback in an `acceptingUpdates`
latch. The latch was reopened in the `finally` block (`acceptingUpdates = true`)
instead of being closed, so a callback captured by the tool could be invoked
after `execute` resolved and after the drive had sealed progress, draining and
publishing its outcome. Late updates then emitted new `tool_update` events and
wrote new checkpoints against a finished invocation.

Repair: the `finally` now sets `acceptingUpdates = false`, the same pattern used
by `executeAgentLoop` and the bash tool. The latch closes before the
`ExecutedToolCall` promise settles, so both the live update channel and the
checkpoint channel (the drive passes `progress.write` from that same callback)
are sealed at completion, for successful and throwing effects alike. Updates
produced while the effect is running are still delivered exactly once.

## 3. Gate: `beginAbort` could reopen a closed gate

`packages/agent/src/harness/execution/effect-gate.ts`

`beginAbort` only ignored calls while the gate was already `aborting`, so a
cancellation request that arrived after `close(error)` replaced the terminal
`closed` state with `aborting`. `gate.admit` then threw a fresh
`AbortRequested` instead of the terminal error, i.e. the gate was reopened and
its terminal error was lost for every later admission.

Repair: `beginAbort` returns unless the state is still `open`
(`if (state.status !== "open") return;`). A closed gate keeps its `closed`
state, its terminal error and its abort reason; a second `beginAbort` on an
aborting gate still keeps the first cancellation promise. Abort-first
admission (`AbortRequested` with the cancellation promise, signal only after
`signalAbort`) is unchanged.

## Cross-module consequence

The repair is deliberately a set of fences rather than a reordering of the
pipeline: cancellation is decided from the durable operation state before the
scheduler replays anything, completion is sealed inside the executor that owns
the callback lifetime, and the gate's owner-side controls can only move the
lifecycle forward. The regression script
(`node --experimental-vm-modules .prale-eval/regression.mjs`) loads the real
modules through `.prale-eval/subject.mjs` and asserts:

- a cancelled safe/safe recovery emits only `read`/`publish`, with no `clear`,
  no `invoke`, no checkpoints, and one interrupted result carrying the
  checkpoint content plus the interruption marker;
- a cancelled unsafe recovery likewise never invokes and publishes once;
- a non-cancelled safe/safe recovery still clears, invokes with persisted
  arguments, preserves `details` and `usage`, seals before publishing, and
  publishes exactly once;
- a captured update callback used after completion emits no events, writes no
  checkpoint and cannot republish the outcome (successful and throwing effects);
- `beginAbort` after `close` neither revives the gate nor replaces its terminal
  error, including through `executeToolCall`, which must surface the terminal
  error and must not invoke the tool.

Each repaired file alone was reverted to its faulty baseline while validating:
each restoration produced a failing `node:assert/strict` assertion (the
scheduler case fails on `clear`/`invoke` events, the executor case on post
completion events, the gate case on `AbortRequested` replacing the terminal
error), never an import error or crash. TypeScript type checking and the
repository's Vitest suite could not be run because `node_modules` is absent in
this workspace; the regression relies only on Node 24 built-ins.
