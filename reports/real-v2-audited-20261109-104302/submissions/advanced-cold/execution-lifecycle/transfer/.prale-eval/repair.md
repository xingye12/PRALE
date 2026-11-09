# Repair: live progress, durable progress and errors diverge

Task `advanced/execution-lifecycle/transfer` (`earendil-works/pi`, mode `repair`).

## Incident shape

A recovered tool call (`drive/tools.ts` -> `execution/tools.ts` -> `effect-gate.ts`) emits
live progress, an explicit checkpoint, and then fails. Three independent regressions broke the
contract at three different layers of that single flow:

| Module | Layer | Faulty baseline | Repair |
| --- | --- | --- | --- |
| `packages/agent/src/harness/runtime/drive/tools.ts` | producer of progress/durability | `if (options?.checkpoint !== false) progress.write(partial);` | `if (options?.checkpoint === true) progress.write(partial);` |
| `packages/agent/src/harness/execution/tools.ts` | effect admission + tool execution boundary | catch block returned `{ result: createErrorToolResult(...), isError: false }` | returns `isError: true` |
| `packages/agent/src/harness/execution/effect-gate.ts` | owner-facing abort lifecycle | `signalAbort()` returned without touching the controller (`// Regression: abort signal is never delivered.`) | aborts the controller: `controller.abort(new AbortRequested(state.cancellation))` |

Only these three statements changed; no API, signature, interface or unrelated behavior was touched.

## Why the three fixes are one cross-module behavior

1. **Observer stream vs. durable stream (`drive/tools.ts`).**
   `performToolInvocation` has two sinks for one update callback: `publishUpdate` (an
   `emitBatch` of a `tool_update` event, i.e. the live observers) and `progress.write`
   (the `pendingToolOutput` recovery snapshot). The baseline sent *every* admitted update to
   `progress.write` unless a tool explicitly passed `checkpoint: false`; harness tools such as
   `tools/bash.ts` pass `{ checkpoint: true }` only for real checkpoints and pass `undefined`
   otherwise, so every tick of live output overwrote the durable recovery snapshot. After the
   repair the live side is unconditional (all admitted updates still reach observers) while the
   durable side is opt-in (`checkpoint === true` only), which is exactly what the
   `AgentHarnessToolUpdateOptions` doc comment (`types.ts`) states.
   The surrounding order is unchanged and now observable: seal -> drain -> `after_tool` ->
   publish, so final publication always follows progress drain and the last delivered update.

2. **A tool exception must stay an error (`execution/tools.ts`).**
   `executeToolCall` deliberately converts a thrown tool error into a result message instead of
   propagating it. The baseline produced that error text but flagged it `isError: false`, so the
   downstream chain (`finalizeToolCall` -> `createToolResultMessage` -> `tool_end` event ->
   durable `toolResult`) published a *successful* tool result carrying an error message. With
   `isError: true` the flag now survives an `after_tool` patch that does not override
   `isError` (`finalizeToolCall` uses `patch?.isError ?? executed.isError`), and the failure
   is visible to observers, to the final message and to termination handling.

3. **Abort delivery to already-admitted work (`effect-gate.ts`).**
   `beginAbort` closes the gate for new admissions (`check()` throws `AbortRequested`), but the
   `AbortController` behind `gate.signal` is what reaches the *already-admitted* effect. The
   baseline never aborted it, so a running tool awaiting `context.abortSignal` (or its abort
   listener) hung until it finished on its own. `signalAbort()` now aborts the controller once,
   only after cancellation is durable (`state.status === "aborting"`), is idempotent, and reuses
   the same `AbortRequested` (with the pending cancellation promise) that admission refusal
   throws, so producers, consumers and observers agree on why the effect stopped. `close()`
   behavior is unchanged (it still aborts with the close error).

Composed effect on the incident: a recovered tool delivering live progress plus one checkpoint and
then throwing now yields exactly one durable checkpoint (`pendingToolOutput`), all admitted live
updates delivered to observers, an `isError: true` final message, and an in-flight tool whose
`AbortSignal` fires when the drive signals abort - while no new effect is admitted after
`beginAbort`.

## Local validation

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

`.prale-eval/regression.mjs` is an executable ES module that imports `.prale-eval/subject.mjs`
(read-only helper) and loads the three real submitted modules through `createExecutionPipeline`,
which wires real recovery/execution/gate/placement code with only external IO boundaries faked
(checkpoint store, progress transport, hook delivery). It contains no sleeps, timers, randomness or
network use; all ordering is driven by explicit promise hand-offs.

Assertions, by scenario:

1. effect gate module: open gate admits, `beginAbort` refuses new admission with `AbortRequested`
   carrying the cancellation, signal stays clear until the cancellation is durable, `signalAbort`
   delivers exactly one abort to the admitted listener and is idempotent (and is a no-op before
   `beginAbort`), `close` refuses with its own error and interrupts admitted work.
2. recovered tool: only the `checkpoint: true` update is persisted, all three admitted updates
   reach observers in order, `seal` -> `drain` -> `publish` ordering, every checkpoint preceding
   the seal, the thrown error text and `isError: true` in the final message, and no late
   update/checkpoint admitted after finalization.
3. abort while the recovered effect runs: the executing tool's `AbortSignal` aborts, its abort
   listener runs once with an `Error` reason, and the refused `after_tool` patch cannot rewrite the
   interrupted error result.
4. already-aborting gate: the external effect is never invoked, no progress is persisted, and the
   cancelled outcome is still published as an error.
5/6. unrelated behavior intact: an open gate still applies `after_tool` content patches without
   clearing the error flag, and successful recovered calls publish a non-error result after drain.

Mutation check performed locally (helper removed afterwards): restoring each file's faulty
baseline in isolation makes the script exit non-zero with a genuine `AssertionError`, and the
repaired workspace passes:

| File restored to baseline | Detected by |
| --- | --- |
| `runtime/drive/tools.ts` | `AssertionError: only the checkpoint=true update may become durable progress` |
| `execution/tools.ts` | `AssertionError: a tool exception remains an error in the final message` |
| `execution/effect-gate.ts` | `AssertionError: signalAbort reaches the already-admitted AbortSignal` |

No crash, import error or timeout is involved in any detection. Runs are fully in-memory: the
regression creates no fixtures, so there are no temporary inputs to clean up, and nothing outside
`.prale-eval/` is written. Node 24 (`v24.14.0`); no dependencies were installed.
