# Repair: recovery authorization must survive effect admission

## Failure chain

Recovery of an interrupted tool batch is a three-stage producer/consumer chain:

1. `runtime/drive/tools.ts` decides whether an `effect_pending` call may be replayed
   and turns the *persisted* arguments into a cleared invocation.
2. `execution/tools.ts` executes that cleared invocation and is the only place where
   the external tool effect is crossed.
3. `execution/effect-gate.ts` is the admission capability that the whole effect
   crossing (tool body and the after-tool hook) must pass through.

Each stage had one defect that let stale model arguments reach the tool.

### 1. `packages/agent/src/harness/execution/effect-gate.ts`

`createGate().gate.admit` invoked the callback without consulting the internal gate
state, so an `aborting` or `closed` pass still admitted the effect. `admit` now runs
the same `check()` used by the rest of the gate:

```ts
admit<T>(invoke: () => T): T {
    check();          // throws AbortRequested(state.cancellation) or state.error
    return invoke();
}
```

The throw is synchronous, which is what the recovery path already relies on: it
catches `AbortRequested` in `performToolInvocation`, drains progress and publishes an
interrupted outcome instead of the effect. `AbortRequested` keeps carrying the
cancellation promise, so `beginAbort` is still awaited by the consumer.

### 2. `packages/agent/src/harness/execution/tools.ts`

`executeToolCall` passed `call.toolCall.arguments` (the original model arguments) to
`tool.execute` and ignored `call.args`, the value that stage 1 had validated, cleared
and persisted. The executed arguments now come from the cleared record:

```ts
const result = await call.tool.execute(
    call.toolCall.id,
    call.args,
    ...
```

`call.toolCall` is still used for identity (`id`, `name`) and for the resulting
message, so nothing outside the argument source changed.

### 3. `packages/agent/src/harness/runtime/drive/tools.ts`

`recoverToolInvocation` admitted a replay when *either* the durable call declaration
or the currently registered tool declared `replay: "safe"` (`||`), and it never
checked that the tool still existed. That both replayed a call whose durable
declaration forbade replay and dereferenced a missing tool. Authorization now requires
both declarations to agree and the tool to be present:

```ts
if (!cancelled && tool !== undefined && call.replay === "safe" && tool.replay === "safe") {
```

Only then is `clearReplayCheckpoint` awaited (deleting the old checkpoint and handing
back the persisted arguments) before `performToolInvocation`. Everything else keeps
the conservative path: read the checkpoint snapshot and publish an interrupted
outcome (`INTERRUPTION_MARKER`). Because `performToolInvocation` seals the progress
channel after the effect settles and awaits `progress.drain()` (and the pending live
update delivery) before resolving, `publishToolOutcome` runs only after the effect and
durable progress have finished; the order is unchanged and is now asserted.

Missing tools, unsafe replay declarations, `cancelled`, an aborting gate and a closed
gate all converge on the same interrupted outcome and none of them execute.

## Regression script

`.prale-eval/regression.mjs` drives the real modules through
`.prale-eval/subject.mjs` (only checkpoint storage, the publication sink and the
progress transport are faked) and asserts observable, cross-boundary behaviour:

- gate module: open admission works; `beginAbort` makes `admit` throw `AbortRequested`
  with the same cancellation promise; `close` makes it throw the close error and no
  callback runs;
- executor module: calling `executeToolCall` with a cleared record whose `args` differ
  from `toolCall.arguments` executes and returns the cleared arguments;
- full recovery chain (safe/safe): event order is
  `clear -> invoke -> update -> checkpoint -> effect-complete -> seal -> drain ->
  drain-complete -> publish`, publication happens exactly once as the last step, and
  neither the effect nor the drain observes a publication;
- unsafe persisted declaration, unsafe tool declaration and a missing tool never
  invoke the effect and keep the durable checkpoint snapshot in the interruption;
- `cancelled`, an aborting gate (signal not raised, so only admission state can stop
  it) and a closed gate never cross the effect boundary.

Ordering is controlled with promises/microtasks only; no timers, randomness or
external IO are involved, and the script writes no input files (nothing to clean up).
Each of the three production modules was restored alone to its faulty baseline and
the script failed with an `AssertionError` for that file (gate: missing
`AbortRequested`; executor: model args observed; drive: effect ran for an unsafe
replay declaration), so all three regressions are independently detected.
