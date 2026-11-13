# Repair: allow safe recovery without corrupting patched outcomes

Task: `advanced/execution-lifecycle/correction` — repository `earendil-works/pi`.
Scope: `packages/agent/src/harness/**` only. Three one-line production repairs, no API or
signature changes, no behaviour changes outside the described incident.

## Faults found

Three independent defects sit on the same execution lifecycle path, one per clause of the
policy clarification.

1. `packages/agent/src/harness/runtime/drive/tools.ts` — `recoverToolInvocation`
   admitted recovery of a durable `effect_pending` tool call with a hard-wired
   `if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe")`.
   Because the guard could never be true, every recovered call took the interruption path:
   a safe/safe call never reran, its persisted arguments (`pi.op.tool_args`) and memos
   (`pi.op.tool_memo`) were never reused, and the checkpoint was published as
   "external outcome is unknown" even though replay was explicitly permitted.

   Repair: `if (!cancelled && call.replay === "safe" && tool?.replay === "safe")`.
   Replay now requires the call to be non-cancelled *and* both the durable call record and
   the current tool declaration to declare `replay: "safe"`. The cancelled branch is
   preserved: a pass whose control status is `cancel_requested` still keeps its checkpoint
   and publishes an interrupted result.

2. `packages/agent/src/harness/execution/tools.ts` — `finalizeToolCall`
   merged the after-tool patch into `isError` with `patch?.isError || executed.isError`.
   With a boolean OR, an explicit `isError: false` from an after-tool hook could never
   clear a failure, so a hook that repaired or downgraded a tool failure still produced an
   error tool-result message.

   Repair: `patch?.isError === undefined ? executed.isError : patch.isError`.
   Field-by-field patch semantics are untouched, so an explicit `false`/empty patch value
   (`isError: false`, `content: []`, `details: {}`) is applied while every field the patch
   does not name — including `usage` and any additional result field carried by the
   executed result object spread — is preserved unchanged. `terminate` keeps its existing
   `=== true` normalization.

3. `packages/agent/src/harness/execution/effect-gate.ts` — `GateControl.close`
   bailed out unless the gate was still `open` (`if (state.status !== "open") return;`).
   A drive pass that was already `aborting` therefore ignored a terminal fault: later
   admissions kept throwing `AbortRequested` bound to a pending cancellation promise that
   the closed drive would never honour, and the abort signal never carried the terminal
   error.

   Repair: `if (state.status === "closed") return;`. `close` is now allowed to move an
   `aborting` gate to `closed`, so the terminal error becomes authoritative for every
   later `admit()` call and is used as the abort reason when the signal is not already
   aborted. `beginAbort` still only starts an abort from an `open` gate and `signalAbort`
   still only fires while `aborting`, so a cancellation that arrives after the closure can
   no longer override or re-reason the closure, and the first closure error wins.

## Cross-module trace

Producer/consumer boundaries that the faults crossed:

- `runtime/drive/tools.ts` (recovery procedure) reads the durable call state written by
  `publishToolIntent`, then hands the call to `execution/tools.ts` (`executeToolCall`,
  `finalizeToolCall`, `createToolResultMessage`). Fault 1 broke this producer/consumer pair:
  the recovery decision was correct in its inputs but unreachable, so `publishToolOutcome`
  staged interrupted messages instead of replayed results.
- `hooks.ts` (`HookRegistry.afterTool`) aggregates an after-tool patch and
  `runtime/drive/tools.ts` forwards it into `finalizeToolCall`. `hooks.ts` already allowed
  `isError: false` through its aggregate (`result.isError !== undefined`); fault 2 discarded
  that value downstream, so the hook contract was violated only at the consumer, and the
  staged durable message (and therefore the `tool_end` event and the transcript) reported an
  error.
- `execution/effect-gate.ts` is the admission boundary used by `execution/tools.ts`
  (`executeToolCall`), `hooks.ts` (`runWithGate`/`runToolWithGate`) and
  `runtime/types.ts` (`Drive.gate`, `Drive.closeGate`, used by `Lane.seal`). Fault 3 made
  the gate's terminal state unreachable from `aborting`, so the cancellation path could win
  over a fault that had already terminated the pass.

`Lane.seal` → `Drive.closeGate` → `GateControl.close` is the closure path; the repair keeps
every caller's contract (`close(error: Error): void`) but makes the terminal error
authoritative, which is what the drive loop, tool procedure and hook admission all rely on.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` links the real modules
(`runtime/drive/tools.ts`, `runtime/drive/tool-placement.ts`, `runtime/progress.ts`,
`runtime/types.ts`, `execution/tools.ts`, `execution/effect-gate.ts`, `hooks.ts`,
`session/values.ts`, `session/commit.ts`, `session/types.ts`) through
`.prale-eval/subject.mjs`, with boundary fakes only for the pi-ai validator, the chord
context helpers, the telemetry span factory, the session invariant error type and an
in-memory Lane/Session. It asserts:

1. closing an aborting gate signals with the terminal error and every later admission
   throws that error, surviving a late cancellation and a second closure;
2. the same through the real `Drive` (`closeGate`, gate reason, drive completion);
3. an after-tool hook really clears `isError` on the durable transcript produced by
   `runTools`, while the hook still observes the raw executed error;
4. `finalizeToolCall` applies explicit `false`/empty patch values and preserves unpatched
   content, details, usage and `terminate`;
5. a durable batch with one safe/safe and one unsafe `effect_pending` call replays only the
   safe call with its persisted args and memos (dropping the stale checkpoint first),
   interrupts the unsafe call with its checkpoint details and usage intact, and advances the
   operation to `checkpoint`;
6. a parallel batch whose cancellation lands after the first admission does not replay the
   second safe call;
7. a tool still running when the drive gate is closed with a terminal fault makes the
   procedure fail with that fault instead of the pending cancellation.

Each repair was re-verified by restoring that single file to its faulty baseline: the script
exits non-zero with a real `node:assert/strict` failure (`the safe/safe replay reruns exactly
once with the persisted arguments and memos`, `the hook clears isError on the durable
transcript`, `closing an aborting gate still signals admitted work`) and no crash, import
error or timeout.

Not run: the repository's vitest suites (`packages/agent/test/**`), because this workspace has
no installed dependencies and installing them is out of scope. The affected existing specs
(`execution-primitives.test.ts` gate cases, `execution-tools.test.ts` patch cases,
`runtime/drive-tools.test.ts` recovery cases) encode exactly the restored semantics.
