# Cancellation and completion must fence off late activity

Task: `advanced/execution-lifecycle/retransfer` — repository `earendil-works/pi`.

## Incident

Two lifecycle fences were missing in the durable harness, and one gate transition was not
terminal:

1. A **cancelled tool recovery still executed**. The recovery scheduler received the cancelled
   state but ignored it, so a `replay: "safe"` call (tool and call both safe) cleared its
   checkpoint and crossed the external effect boundary even though the operation was already
   `cancel_requested`.
2. A **completed tool could still emit updates**. The executor's `onUpdate` seal was reset to
   `acceptingUpdates = true` in the `finally` block instead of being closed, so a tool that kept
   its callback and fired after it settled could publish new `tool_update` events and new
   checkpoint writes.
3. **`beginAbort` reopened a closed gate**. The owner-facing transition only short-circuited when
   the gate was already `aborting`, so a late cancellation attempt after `close(error)` replaced
   the terminal state with `aborting`. `Gate.admit` then threw `AbortRequested` instead of the
   sealed terminal error (the abort signal reason also stopped matching the terminal error).

## Cross-module repair

The three modules form one boundary chain — `runtime/drive/tools.ts` (scheduler) drives
`execution/tools.ts` (executor) through `execution/effect-gate.ts` (admission gate) — so the
fences are enforced where each piece of state lives:

- `packages/agent/src/harness/runtime/drive/tools.ts`
  `recoverToolInvocation` now takes its `cancelled` argument seriously:
  `if (!cancelled && call.replay === "safe" && tool?.replay === "safe")`. A cancelled recovery
  skips `clearReplayCheckpoint` (no checkpoint delete, no recovery `tool_start`) and skips
  `performToolInvocation` (no effect admission, no live updates, no progress channel). It only
  reads the durable checkpoint and publishes the single interrupted outcome, preserving the
  checkpoint's `details` and `usage`. The `cancelled` flag is the one the parallel scheduler reads
  from the freshly observed durable control state, so a cancellation that lands between two
  scheduled recoveries fences the second one. Non-cancelled safe/safe recovery is untouched: it
  still clears the checkpoint, replays the persisted arguments, and publishes exactly one
  `tool_start`/`tool_end` pair with the executed `content`, `details` and `usage`.
- `packages/agent/src/harness/execution/tools.ts`
  `executeToolCall` now sets `acceptingUpdates = false` in its `finally` block. The flag guards the
  single callback that the runtime uses for both effects — the live `tool_update` emit and the
  `{ checkpoint: true }` durable progress write — so sealing it at completion (or failure, including
  `AbortRequested`) seals both channels at once. Updates emitted while the tool is still running
  keep flowing; anything after settlement is dropped.
- `packages/agent/src/harness/execution/effect-gate.ts`
  `beginAbort` now refuses any non-open state (`if (state.status !== "open") return;`). A closed
  gate is terminal: `admit` keeps throwing the original terminal error object, `signal.reason`
  keeps that error, and a repeat `close` still cannot replace it. A genuinely `aborting` gate
  behaves as before: it refuses admission with `AbortRequested` carrying the cancellation promise
  and only aborts its signal once `signalAbort()` runs.

No public API changed; only the internal transitions were fenced.

## Validation

`.prale-eval/regression.mjs` links the three real production modules in one VM graph
(`createGraph`) and fakes only the outer boundaries (durable value store/reader, progress channel,
placement helpers, `validateToolArguments`, `withAbortSignal`). The drive-tools module exposes its
private `recoverToolInvocation` through a test-only trailer so the scheduler can be driven directly
with a controlled fake lane/drive; asynchronous ordering is controlled with promises, never with
timers.

`node --experimental-vm-modules .prale-eval/regression.mjs` asserts:

- gate: open gate admits once; after `close(terminal)` a late `beginAbort` + `signalAbort` still
  refuses admission with the *same* terminal error object, never invokes, keeps
  `signal.reason === terminal`, and a second `close` cannot replace it; an aborting gate still
  refuses with `AbortRequested` and signals only after cancellation settles;
- executor: in-flight updates and `{ checkpoint: true }` intents are delivered, a late update after
  the tool resolved is dropped, and a sealed gate refuses the effect before the tool body runs;
- scheduler (cancelled): no progress channel, no checkpoint write, checkpoint is read before it is
  settled, no effect invocation, no `tool_start`/`tool_update`, exactly one interrupted
  `tool_end` with the marker text plus the checkpoint's `details`/`usage`, one staged durable
  result;
- scheduler (non-cancelled safe/safe): replays persisted args once, clears the checkpoint, and
  publishes exactly one `tool_start` and one `tool_end` with preserved `content`, `details` and
  `usage`.

Restoring any one of the three production files to its faulty baseline makes the script fail with
an assertion (never a crash or import error): the gate file fails on the terminal-error identity,
the executor file fails on the late-update count, and the scheduler file fails because the
cancelled recovery opens a progress channel and invokes the tool.

A repository-wide `vitest` run was not possible here: the workspace has no installed
`node_modules` and dependencies must not be installed, so `.prale-eval/regression.mjs` is the
focused executable validation.
