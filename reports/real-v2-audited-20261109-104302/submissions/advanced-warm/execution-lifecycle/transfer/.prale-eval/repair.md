# Cross-module repair: live progress, durable progress, errors and abort delivery

## Failure shape

A recovered tool (`call.status = "effect_pending"`, `replay: "safe"`) is replayed by
`runtime/drive/tools.ts`. The drive clears its replay checkpoint, admits the effect
through `execution/effect-gate.ts`, executes `tool.execute` via `execution/tools.ts`,
forwards every `onUpdate` to observers, persists only the updates that request a durable
checkpoint, then seals/drains progress and finally publishes the staged outcome. One
independent defect in each of the three modules broke that chain:

| Module | Defect | Observable divergence |
| --- | --- | --- |
| `runtime/drive/tools.ts` | `if (options?.checkpoint !== false) progress.write(partial)` persisted **every** update (any update with no options, or `{checkpoint: false}`) | live-only progress overwrote the durable recovery snapshot, so a later interruption reconstructed the wrong checkpoint |
| `execution/tools.ts` | `executeToolCall`'s catch returned `isError: false` for a thrown tool | the tool exception was silently reclassified as success in the finalized `ToolResultMessage` and in the post-commit `tool_end` event |
| `execution/effect-gate.ts` | `signalAbort()` matched the guard but never aborted the controller | `beginAbort` closed admission, yet an already-admitted tool's `AbortSignal` never fired, so cancellation could not reach the running effect |

## The cross-module fix

1. **Durable checkpoint selection (`drive/tools.ts`).** The progress callback now writes
   to the durable channel only when `options?.checkpoint === true`, matching the
   `AgentHarnessToolUpdateOptions.checkpoint?: true` contract and the documented §3.8
   rule. Observer delivery (`publishUpdate` → `tool_update` / `lane.emitBatch`) is
   unchanged and still happens for every admitted update, checkpointed or not. Because
   `progress.write` still runs synchronously inside the tool callback, the latest
   checkpoint write is enqueued before `progress.seal()` and is awaited by
   `progress.drain()`.

2. **Error classification (`execution/tools.ts`).** A thrown/rejected `tool.execute`
   still converts to an error `content` result (the tool boundary remains total), but now
   reports `isError: true`. `finalizeToolCall` therefore propagates `true` unless an
   `after_tool` patch explicitly overrides it, and `createToolResultMessage` stages an
   error message — the final durable publication keeps the tool exception an error.

3. **Abort delivery (`effect-gate.ts`).** `signalAbort()` now aborts the gate-owned
   `AbortController` after the existing guard (`state.status === "aborting"` and not yet
   aborted), so the signal already handed to the admitted tool via
   `withAbortSignal(gate.signal, context)` fires. `beginAbort` still synchronously refuses
   *new* admission with `AbortRequested`, so no effect can be admitted after abort begins;
   `signalAbort` remains idempotent and `close(error)` still aborts immediately with its
   own error as the reason.

Ordering is preserved end to end: intent → admit → live `tool_update` delivery +
checkpoint writes → seal → drain (latest update delivery, then latest checkpoint write) →
`after_tool` (admission-gated, refused as `AbortRequested` under abort) → final staging
publication. Final publication therefore always follows the progress drain, including the
abort path.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (from the workspace root)
loads the real `drive/tools.ts` → `execution/tools.ts` → `effect-gate.ts` modules through
`.prale-eval/subject.mjs`; only checkpoint storage, progress transport, hook delivery and
the tool effect are faked. The script asserts, with uncaught `node:assert/strict`
assertions:

- every admitted live update (checkpointed and live-only, in order) reaches observers,
  while only `checkpoint: true` updates are persisted, even when the tool then throws;
- the thrown tool becomes `isError: true` with the exception text in the published
  outcome, and `terminate` stays `false`;
- event ordering: `clear` < `invoke`, checkpoint write < `seal`, last `update` < `drain`,
  `drain-complete` < `publish`, `publish` last;
- with a drain held open by a promise, no publication occurs until the drain resolves
  (no timers; ordering is driven purely by promise resolution);
- `control.signalAbort()` aborts the already-admitted tool's signal and the tool observes
  the `abort` event, while `beginAbort` alone does not pull the signal, refuses new
  `admit` calls with `AbortRequested` (invoke never runs) and `close(error)` refuses with
  that same error;
- an unsafe/non-replayed recovered call is not re-executed and publishes the checkpoint
  evidence plus the interruption marker as an error.

Per-file baseline check (performed locally, each file restored from Git in isolation and
then repaired again): restoring any single module to its faulty baseline makes the script
exit non-zero with a real `AssertionError` — `drive` fails the persisted-checkpoint
deep-equal, `execution` fails `isError === true`, `effect-gate` fails
"signalAbort must abort the already-admitted tool signal". No case crashes, fails to
import or times out, so each mutation is genuinely detected.

No dependencies, network, credentials, timers, randomness or external services are used.
The subject helper drives all fakes in memory, so no on-disk fixture is created and there
is nothing left to clean up under `.prale-eval/` besides the required artifacts.
