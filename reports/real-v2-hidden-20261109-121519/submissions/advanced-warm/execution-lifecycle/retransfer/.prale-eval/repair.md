# Repair: cancellation and completion must fence off late activity

Task: `advanced/execution-lifecycle/retransfer` (repository `earendil-works/pi`, mode `repair`).

## Symptoms in the incident

1. A cancelled recovery of a `safe`/`safe` tool call still replayed the persisted
   arguments (`clearReplayCheckpoint`) and re-executed the external effect
   (`performToolInvocation`). Cancellation had already been durably recorded, so
   the tool crossed the effect boundary a second time.
2. A tool that kept its `onUpdate` callback after `execute()` resolved could keep
   emitting live `tool_update` batches and durable progress checkpoints after
   completion, so a settled result kept mutating the drive.
3. `GateControl.beginAbort` moved a *closed* gate back to `aborting`, so a later
   `admit()` threw `AbortRequested` (with the wrong cancellation promise) instead
   of the gate's terminal error.

## Root causes (one per module)

### `packages/agent/src/harness/runtime/drive/tools.ts` — recovery scheduler

`recoverToolInvocation` accepted a `cancelled` flag (passed by `runParallel` from
the durable control status) but never consulted it. The safe/safe replay path was
taken unconditionally, so a cancelled drive cleared the replay checkpoint and
invoked the tool again.

Fix: the replay path is now guarded by `!cancelled`.

```ts
if (!cancelled && call.replay === "safe" && tool?.replay === "safe") { ... }
```

A cancelled recovery therefore falls through to the durable interrupted-outcome
path (`readCheckpoint` + `publishToolOutcome(interruptedOutcome(...))`), which is
exactly the path `runSequential` already used for `cancel_requested` controls: it
never clears the replay checkpoint, never crosses the tool-effect boundary, and
publishes exactly one outcome that preserves the checkpoint content, details and
usage plus the interruption marker.

Non-cancelled safe/safe recovery keeps its original behaviour: clear (restoring
the persisted arguments), execute once under gate admission, finalize through the
after-tool hook, and publish one outcome with the tool's usage and details intact.

### `packages/agent/src/harness/execution/tools.ts` — tool executor

`executeToolCall` guards live progress with a local `acceptingUpdates` flag, but
the `finally` block re-opened the flag (`acceptingUpdates = true`) instead of
closing it. Because the flag was also never set to `false`, an update emitted by
the tool after its promise resolved was still forwarded to the drive, so progress
publishing and checkpoint writes outlived completion.

Fix: the `finally` block now seals the fence.

```ts
} finally {
    // Completion seals live progress: post-completion updates must never be delivered.
    acceptingUpdates = false;
}
```

This seals both downstream callbacks that the drive wires into the executor in
`performToolInvocation`: `lane.emitBatch` live `tool_update` publishing and
`progress.write` durable checkpointing (`options.checkpoint === true`).

### `packages/agent/src/harness/execution/effect-gate.ts` — effect gate

`beginAbort` only short-circuited when the state was already `aborting`, so a
`closed` gate was silently reopened into `aborting`, replacing the terminal error
with an `AbortRequested` carrying an unrelated cancellation promise.

Fix: cancellation is only accepted from the `open` state.

```ts
if (state.status !== "open") return;
```

`close()` remains the last word (`aborting` → `closed` still works, and the
abort signal keeps the terminal error as its reason), and aborting an `open` gate
still requests abort with the supplied cancellation promise. No public API
changed: `Gate`, `GateControl`, `createGate`, `AbortRequested` and the harness
call signatures are untouched.

## Cross-module interaction

The three fences compose:

- The scheduler decides *whether* an effect may be replayed at all; a cancelled
  drive stops before the gate, the executor and the checkpoint store are touched.
- The gate decides *whether admission is currently allowed* and keeps a closed
  drive terminal, so no late `admit()` can be misread as a fresh cancellation.
- The executor decides *whether progress may still flow* after the tool's own
  promise settled, covering both the live update channel and the checkpoint
  channel that the drive wires through it.

## Validation

`.prale-eval/regression.mjs` loads the real modules through `.prale-eval/subject.mjs`
(`createExecutionPipeline`) with only checkpoint storage, progress transport and
outcome publication faked, and asserts observable behaviour across module
boundaries:

1. non-cancelled safe/safe recovery clears → invokes → publishes once, with the
   recovered arguments, usage and details preserved;
2. a cancelled recovery performs no `clear` and no `invoke`, reads the durable
   checkpoint, emits no updates and no checkpoints, and publishes exactly one
   interrupted outcome preserving checkpoint content and details;
3. the same holds for a cancelled recovery of a `never`-replay call;
4. after completion, a retained update callback (with `checkpoint: true`) produces
   no further `tool_update` batch, no checkpoint write and no drive event;
5. a closed gate stays terminal after `beginAbort` and the executor surfaces that
   terminal error without invoking the tool;
6. aborting an open gate still yields `AbortRequested` with the given cancellation
   promise, and a later `close` still wins.

Run:

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

Result: `passed`. Restoring any one of the three production files to its faulty
baseline makes the script fail with a plain `node:assert/strict` assertion
(detected individually: scheduler → cancelled recovery clears/invokes; executor →
post-completion update delivered; gate → closed gate reopens). No timers,
randomness or external services are used; ordering is driven only by promises.
