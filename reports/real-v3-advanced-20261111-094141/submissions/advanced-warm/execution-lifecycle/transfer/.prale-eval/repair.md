# Repair: live progress, durable progress and errors diverge

Task: `advanced/execution-lifecycle/transfer` — repository `earendil-works/pi`.

## Incident

A recovered tool invocation (`effect_pending`, `recovery: true`) emits live progress, an
explicit checkpoint (`{ checkpoint: true }`), then throws. The observed behaviour was wrong
in three independent places along the producer/consumer chain:

| Boundary | Required | Observed before the repair |
|---|---|---|
| `runtime/drive/tools.ts` → `runtime/progress.ts` | only `checkpoint: true` updates are persisted; every admitted update still reaches observers | every update was persisted (`options?.checkpoint !== false` is always true because the option type is `checkpoint?: true`) |
| `execution/tools.ts` → `runtime/drive/tools.ts` | a tool exception stays an error in the final message | the `catch` in `executeToolCall` returned `isError: false`, so the staged `ToolResultMessage`, the `after_tool` event payload and the `tool_end` event all reported success |
| `execution/effect-gate.ts` → admitted tool/provider | `signalAbort()` must pull the signal of work that was already admitted | `signalAbort()` only checked its guard and never aborted the controller, so `requestAbort` committed the durable marker without ever reaching the running tool's `AbortSignal` (retry timers and in-flight provider streams also hung until they finished on their own) |

All three sit on the same call path, so the divergence showed up as one symptom: live output
streamed, the durable checkpoint was wrong (or missing), and the terminal result claimed
success.

## Changes (3 lines of production code)

1. `packages/agent/src/harness/execution/effect-gate.ts` — `GateControl.signalAbort()` now
   performs the abort it was already guarding:

   ```ts
   signalAbort() {
       if (state.status !== "aborting" || controller.signal.aborted) return;
       controller.abort(new AbortRequested(state.cancellation));
   }
   ```

   The reason is the gate's own `AbortRequested(cancellation)`, which is what every consumer of
   `gate.signal` expects: `waitUntil()` rejects with `signal.reason` and `driveOperation()`
   only tolerates `AbortRequested` as *expected* cancellation; provider requests and tool
   contexts only need `signal.aborted`. `close()` keeps aborting with the closing error, so the
   two lifecycle paths stay distinguishable.

2. `packages/agent/src/harness/execution/tools.ts` — the `executeToolCall` catch now returns
   `isError: true`. `finalizeToolCall` propagates `executed.isError` unless an `after_tool`
   patch overrides it, so the error flag reaches the staged `pendingEntry` message, the
   `after_tool` event and `tool_end`.

3. `packages/agent/src/harness/runtime/drive/tools.ts` — the update consumer in
   `performToolInvocation` now gates durable persistence on the explicit request:

   ```ts
   (partial, options) => {
       publishUpdate(partial);                                  // always live
       if (options?.checkpoint === true) progress.write(partial); // durable only on request
   }
   ```

   `publishUpdate` (the `tool_update` event path) is unchanged, so every admitted live update
   still reaches observers; only the scalar `pendingToolOutput` replacement is now restricted to
   `checkpoint: true`.

Behaviour that was already correct and is preserved (and now asserted): `gate.admit` refuses
new effects synchronously after `beginAbort` with `AbortRequested`; `executeToolCall` still
fences late updates with `acceptingUpdates`; `performToolInvocation` still seals and drains the
progress channel (and awaits the latest live delivery) before `after_tool` and before the
outcome it publishes; the interruption/abort synthetic outcomes keep `terminate: false` and
`isError: true`.

## Cross-module regression

`.prale-eval/regression.mjs` links four real modules in one VM graph
(`effect-gate.ts`, `execution/tools.ts`, `runtime/progress.ts`, `runtime/drive/tools.ts`) with
`createGraph` and supplies its own boundary fakes: a scalar Session store with real bound-value
address descriptors, a serialized lane mutation line, an `emitBatch` event bus with a
promise-controlled delivery, and a `HookRegistry`-shaped hook bus that admits through the real
gate. Only the module-private `performToolInvocation` is exposed through the `trailers`
mechanism; no production code is patched or stubbed.

Scenarios (all ordering controlled with promises, no timers):

1. gate: fresh gate admits; `beginAbort` alone neither signals nor admits; `signalAbort`
   aborts, fires the listener once, and carries `AbortRequested`.
2. `executeToolCall`: synchronous and asynchronous throws are error results with the original
   message; an abort-first gate never starts the tool and surfaces the gate's own
   `AbortRequested` (cross-module class identity).
3. recovered invocation: three updates (live, checkpoint, live) — observer sees all three in
   order tagged `recovery`, the store shows `undefined` → `checkpoint` → still `checkpoint`,
   and the thrown tool yields `isError: true` plus an `after_tool` that observes the error.
4. ordering: with the checkpoint commit and the live delivery both held open, `after_tool`
   cannot run; after release the mutation log is `commit → after_tool → publish-outcome`.
5. abort after admission: the tool observes the gate signal, the listener fires after
   `signalAbort`, the tool's real result is kept (`isError: false`), and `after_tool` does not
   start because the gate refuses admission.

Verified detection: restoring any one of the three files to its faulty baseline makes the
script fail with an assertion (gate → "signalAbort must abort the admitted work's signal";
tools → "a synchronous tool throw must stay an error result"; drive/tools → "a live-only update
must never be persisted"), and restoring all three fails as well. No crash, import error or
timeout is involved.

Validation: `node --experimental-vm-modules .prale-eval/regression.mjs` → passes.
The repository's own vitest suites could not be run because no dependencies are installed in
this workspace and installing them is out of scope; the behaviours they cover are reproduced by
the regression above against the same modules.
