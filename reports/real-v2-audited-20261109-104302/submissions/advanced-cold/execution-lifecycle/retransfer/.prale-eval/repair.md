# Repair: cancellation and completion must fence off late activity

## Failure chain (producer -> consumer)

1. **Effect gate (producer of refusals)** — `packages/agent/src/harness/execution/effect-gate.ts`
   `control.beginAbort()` only short-circuited when the gate was already `aborting`
   (`if (state.status === "aborting") return;`). A cancellation that arrived *after*
   `control.close(error)` therefore overwrote the `closed` state with `aborting`,
   reopening the gate and replacing the terminal error with an `AbortRequested`.
   Every later `gate.admit()` — the executor's effect admission, the before/after tool
   hooks — was then refused with a cancellation instead of the terminal error, so
   already-sealed work could be re-entered.

2. **Tool executor (consumer of admissions, producer of updates)** — `packages/agent/src/harness/execution/tools.ts`
   `executeToolCall()` wraps the tool's `update` callback in an `acceptingUpdates` latch,
   but the latch was reset to `true` in the `finally` block that runs on completion.
   A tool that kept its callback and fired once more after its promise settled pushed a
   late `tool_update` event into the lane and, when it carried `{ checkpoint: true }`,
   a late durable checkpoint write through `progress.write()`.

3. **Recovery scheduler (producer of replayed effects)** — `packages/agent/src/harness/runtime/drive/tools.ts`
   `recoverToolInvocation()` received the `cancelled` flag from `runParallel()` but never
   read it. A recovered `effect_pending` call whose replay was `safe` on both sides was
   cleared (`clearReplayCheckpoint`) and re-invoked (`performToolInvocation`) even though
   the run had already been cancelled, re-opening an external effect that cancellation
   was supposed to fence off.

The three defects compose: the gate reopens, the executor keeps emitting, and the
scheduler re-executes; each one alone is enough to publish an outcome that the durable
run no longer owns.

## Fix

* `effect-gate.ts`: `beginAbort` now only transitions an `open` gate
  (`if (state.status !== "open") return;`). A closed gate keeps its terminal error for
  every future `admit()`, and its abort reason is never displaced. Repeated
  `beginAbort` while `aborting` still keeps the first cancellation promise, and
  `close()` while aborting still wins — unchanged.
* `execution/tools.ts`: the `finally` latch now sets `acceptingUpdates = false`, so
  completion seals both the live (`onUpdate`) and the checkpoint (`options.checkpoint`)
  path at their single choke point inside the executor. Updates emitted *during* the
  tool body still flow (the latch starts at `true` and only flips when the effect
  settles).
* `runtime/drive/tools.ts`: `recoverToolInvocation()` gates the safe-replay branch on
  `!cancelled`. A cancelled recovery skips `clearReplayCheckpoint` and
  `performToolInvocation`, reads the durable checkpoint, and publishes exactly one
  `interruptedOutcome` carrying the checkpoint content/details/usage.

## Preserved behavior

* Non-cancelled `safe`/`safe` recovery still clears, invokes, seals, drains and
  publishes exactly once, preserving `details` and `usage`.
* Non-safe replay still stages the checkpoint-based interruption outcome.
* Hook gating, memo capability expiry, progress seal/drain ordering and event payloads
  are untouched.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` loads the three modules
through `.prale-eval/subject.mjs` and asserts, with uncaught `node:assert/strict`
assertions and promise-ordered effects (no timers, randomness or IO):

* gate: `close` then `beginAbort` still refuses with the terminal error; the abort
  reason stays terminal; `close` after `beginAbort` wins; the first cancellation wins
  between aborts;
* gate + executor: a closed gate refuses the effect without invoking the tool or
  delivering updates;
* executor: updates emitted after completion are sealed, including checkpoint-bearing
  ones, while mid-flight live/checkpoint updates are still delivered;
* drive: cancelled `safe`/`safe` recovery records `read` + one `publish` and never
  `clear`/`invoke`, staging the interruption marker with checkpoint details;
* drive: non-cancelled `safe`/`safe` recovery completes with the full
  `clear → invoke → effect-complete → seal → drain → publish` sequence and preserves
  `details`/`usage`; a non-safe replay stages the checkpoint outcome.

Each source file was also restored individually to its faulty baseline during local
verification; in every case the script exits non-zero with an `AssertionError` (no
import error, crash or timeout).
