# Repair: recovery authorization must survive effect admission

## Incident chain

`runtime/drive/tools.ts` decides whether an orphaned `effect_pending` call may be
re-executed, `execution/tools.ts` performs the admitted effect, and
`execution/effect-gate.ts` is the single synchronous admission boundary that must
refuse the effect when the drive is aborting or closed. The incident broke all three
links, so an interrupted, un-authorized operation was replayed and the replayed
effect ran with the original model arguments instead of the persisted arguments.

Per `packages/agent/docs/tool-durability.md` ("Safe recovery", "Unsafe recovery with
partial output") and `packages/agent/docs/harness.md` §4.2/§4.5, the required
semantics are:

- replay only when **both** the stored declaration and the current tool declaration
  are `replay: "safe"`;
- a missing implementation / missing or no-longer-safe declaration is an unsafe
  interruption, never a suspension and never an execution;
- the old progress checkpoint is deleted before the replay is admitted;
- the replayed effect executes the persisted (`pi.op.tool_args`) arguments under the
  same invocation id, while the provider tool call itself is untouched;
- the outcome is published `outcome_ready` only after the effect settled and the
  durable progress/update writes drained;
- `Gate.admit` performs the only lifecycle check: aborting throws
  `AbortRequested(cancellation)`, closed rethrows the closing error, and `invoke`
  never runs in either case.

## Defects and minimal repairs

1. `packages/agent/src/harness/runtime/drive/tools.ts` — `recoverToolInvocation()`
   authorized replay with `call.replay === "safe" || tool?.replay === "safe"`.
   A single safe declaration (or a missing tool, whose declaration is `undefined`)
   was therefore enough to clear the checkpoint and re-execute an effect of unknown
   outcome. Replaced with a conjunction that also requires the tool to exist:

   ```ts
   if (!cancelled && call.replay === "safe" && tool !== undefined && tool.replay === "safe") {
   ```

   Everything else in the recovery path already matched the documented contract:
   `clearReplayCheckpoint()` commits `deleteValue(pendingToolOutput(...))` and yields
   the persisted arguments in one transaction before `performToolInvocation()` runs,
   and `performToolInvocation()` awaits live-update delivery plus `progress.drain()`
   before the outcome is published. Restoration keeps that ordering intact.

2. `packages/agent/src/harness/execution/effect-gate.ts` — `gate.admit()` invoked the
   callback without consulting the gate state, so cancellation (`beginAbort`) and
   closure (`close`) could not prevent a new effect from starting. `admit()` now calls
   the existing `check()` before `invoke()`; the check is synchronous, so
   `AbortRequested` / the closing error escape before any effect code runs. No API
   changed: state transitions, `signal`, `beginAbort`, `signalAbort`, `close` are
   untouched.

3. `packages/agent/src/harness/execution/tools.ts` — `executeToolCall()` passed
   `call.toolCall.arguments` (the provider/model arguments) to `tool.execute()`,
   discarding the cleared/persisted `call.args` produced by preparation, hook
   replacement, or durable replay. It now passes `call.args`. `toolCall` stays the
   provider call, so ids, names and the transcript remain authoritative.

Together these restore the intended sandwich: durable declaration + current
declaration → checkpoint clear + persisted args → synchronous gate admission →
effect with persisted args → drain → publish.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` drives the real submitted
`runtime/drive/tools.ts`, `execution/tools.ts` and `execution/effect-gate.ts` through
`.prale-eval/subject.mjs` (only checkpoint storage, progress transport, hook delivery
and the tool effect are faked). It asserts, across module boundaries:

- an aborting gate throws `AbortRequested` (with the pending cancellation promise)
  without running admitted work, and a closed gate rethrows its closing error;
- safe replay clears the checkpoint first, executes the **persisted** arguments once,
  leaves the provider tool call unchanged, and never publishes before the effect
  finished;
- publication waits for a promise-controlled durable progress drain
  (`progressDrain`), with live updates delivered and the checkpoint written first;
- stored-safe/current-`never`, stored-`never`/current-safe and missing-tool recoveries
  never cross the effect boundary, keep the checkpoint (no `clear`), read it, and
  publish an `isError` result containing the durable snapshot plus the
  "external outcome is unknown" marker;
- durable cancellation and an aborting gate refuse the replay effect entirely, and a
  closed gate rejects the pass instead of publishing an outcome.

Replacing each repaired file individually with its faulty baseline (gate check
removed, `call.args` reverted to `call.toolCall.arguments`, `||` replay condition)
makes the script fail with an `AssertionError` in every case, while the repaired tree
passes. Asynchronous ordering is controlled only by promises (a deferred drain and
microtask flushing); no timers, randomness, network or credentials are used. The
script's workspace-local scratch input under `.prale-eval/.tmp-regression-scratch/` is
created and removed by the script itself.

The repository's `vitest` suites could not be executed in this environment because
`node_modules` is absent and installing dependencies is out of scope for this task;
the standalone Node 24 regression above is the executed validation.
