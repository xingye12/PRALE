# Repair: live progress, durable progress and errors diverge

Task: `advanced/execution-lifecycle/transfer` — repository `earendil-works/pi`.

## Symptom

A tool invocation that is replayed after recovery (`recoverToolInvocation` → safe replay
path) emits live progress, an explicit checkpoint and then fails. The observable contract
was broken in three places along one execution pipeline:

1. every live update was written into the durable recovery snapshot, not only the update
   that the tool flagged as a checkpoint;
2. a tool effect that threw was finalized as a *successful* result (`isError: false`), so
   the failure disappeared from the tool-result message and from the `tool_end` event;
3. `GateControl.signalAbort()` was a no-op, so cancellation never reached the
   `AbortSignal` of the tool effect that had already been admitted.

## Root causes and fixes

### 1. `packages/agent/src/harness/runtime/drive/tools.ts` — checkpoint filter

`performToolInvocation` wires the tool's update callback into two sinks: the live
observation channel (`lane.emitBatch` → `tool_update` events) and the durable progress
channel (`openToolProgress` → `pendingToolOutput` snapshot used by recovery).

```diff
 			(partial, options) => {
 				publishUpdate(partial);
-				if (options?.checkpoint !== false) progress.write(partial);
+				if (options?.checkpoint === true) progress.write(partial);
 			},
```

`AgentHarnessToolUpdateCallback`'s second argument is `{ checkpoint?: true }`
(`harness/types.ts`) — checkpointing is strictly opt-in, and the bash tool for example
passes `undefined` for ordinary progress. The `!== false` test inverted the default, so
every live delta replaced the durable snapshot. Live updates must still reach observers
unconditionally (that part is untouched), only persistence is now opt-in.

### 2. `packages/agent/src/harness/execution/tools.ts` — tool exception classification

`executeToolCall` converts an expected tool throw into a synthetic error result, but the
`isError` flag of that conversion was `false`, so `finalizeToolCall`/`createToolResultMessage`
published a message that claimed success (and `after_tool` hooks received `isError: false`).

```diff
 			return {
 				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
-				isError: false,
+				isError: true,
 			};
```

`createErrorToolResult` is only used for the failure path, so returning `isError: false`
there was self-contradictory: the thrown message text was carried into a message marked as
a success.

### 3. `packages/agent/src/harness/execution/effect-gate.ts` — abort delivery

```diff
 			signalAbort() {
 				if (state.status !== "aborting" || controller.signal.aborted) return;
-				// Regression: abort signal is never delivered.
+				// Cancellation is durable at this point; release admitted work through its signal.
+				controller.abort();
 			},
```

The two-phase gate contract is preserved: `beginAbort(cancellation)` only closes admission
(new `admit` calls throw `AbortRequested` carrying the cancellation promise) and leaves
`gate.signal` untouched; once the owner knows the cancellation is durable it calls
`signalAbort()`, which must abort the gate's controller so every already-admitted effect
that received `withAbortSignal(gate.signal, context)` observes the abort. `close(error)`
still aborts with the closing error, and `signalAbort()` remains idempotent.

## Why this is a cross-module fix

The three modules form one execution pipeline and each violation was only observable
through the composition:

- `runtime/drive/tools.ts` owns the progress/observation split and calls
  `executeToolCall` from `execution/tools.ts`, which admits through `Gate` from
  `execution/effect-gate.ts`;
- the progress channel is drained (`seal()` → `drain()`) by the drive procedure *before*
  `publishToolOutcome` runs, so the durable outcome (including the `isError` produced by
  `execution/tools.ts`) is published only after live progress settled — this ordering is
  asserted, not changed;
- the `AbortSignal` a tool receives is `gate.signal`, so an inert `signalAbort()` in
  `execution/effect-gate.ts` silently strands the admitted effect in
  `runtime/drive/tools.ts`, and an aborting gate is what keeps the `after_tool` hook
  (`admit`) from running new effects.

No public API, type or signature was changed; only the three faulty behaviours were
corrected. `runtime/drive/tool-placement.ts`, hooks, storage and event shapes are
untouched.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs`

The script drives the real modules through `.prale-eval/subject.mjs`
(`createExecutionPipeline`: real recovery entry, real tool executor/finalizer, real effect
gate, real driver progress channel; only checkpoint storage, progress transport and hook
delivery faked) and asserts, with uncaught `node:assert/strict` assertions:

1. `checkpoint: true` is the only durable write; all three live updates still reach
   observers, in order, marked `recovery: true`;
2. a throwing recovered tool publishes a message with `isError: true` and the thrown
   message text;
3. `beginAbort` alone does not abort the signal, `signalAbort()` (after the cancellation
   promise resolves) aborts the signal of the already-admitted tool; the aborted effect
   fails into an error message and the `after_tool` patch is refused; a later
   `gate.admit` throws `AbortRequested` carrying the cancellation;
4. an already-aborting gate admits no effect at all (no `invoke`, no progress writes) and
   the interruption is published as an error;
5. the durable checkpoint snapshot is read back and prepended to the interrupted message
   when the effect is not replayable;
6. publication happens only after `seal` → `drain` → `drain-complete`, proven by blocking
   the drain on a promise controlled by the test (no timers, no randomness).

Ordering is driven exclusively by promises. Restoring **any single** faulty baseline file
(`runtime/drive/tools.ts`, `execution/tools.ts` or `execution/effect-gate.ts`) makes the
script fail with an `AssertionError` (verified for each file in isolation); with the repair
in place it exits 0.
