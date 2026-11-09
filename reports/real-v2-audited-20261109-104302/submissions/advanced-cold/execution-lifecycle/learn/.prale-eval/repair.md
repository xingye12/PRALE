# Repair: recovery authorization must survive effect admission

## Incident

A restored (`effect_pending`) tool call was replayed even though its replay was not
authorized, and the replay ran with the *model's* arguments instead of the
arguments persisted in the durable checkpoint. The gate that is supposed to stop
an effect from being admitted after cancellation/closure admitted everything.

The chain is a producer/consumer pipeline across three modules:

```
runtime/drive/tools.ts            execution/tools.ts              execution/effect-gate.ts
recoverToolInvocation  ──────►  executeToolCall(cleared)  ──────►  gate.admit(effect)
  - decides authorization          - runs the external effect        - owns cancellation/closed state
  - clears old checkpoint          - supplies the arguments
  - publishes the outcome          - runs under gate.signal
```

Each module had one independent defect; all three had to be repaired for the chain
to be safe.

## 1. `packages/agent/src/harness/runtime/drive/tools.ts` (producer / authorization)

`recoverToolInvocation` decided replay safety with

```ts
if (!cancelled && (call.replay === "safe" || tool?.replay === "safe"))
```

Two independent holes:

* **`||` instead of `&&`** — replay was admitted when *either* the persisted call
  declaration *or* the tool declaration was safe. A tool that declares `replay:
  "never"` (e.g. an unidempotent write) was replayed whenever the checkpoint
  happened to say `"safe"`, and a checkpoint declared `"never"` was replayed
  whenever the tool said `"safe"`. Authorization requires **both** declarations to
  be safe.
* **optional chaining on a missing tool** — `tool?.replay` made a missing tool look
  "safe enough" as long as the call declaration was `"safe"`, so recovery cleared
  the checkpoint and entered the effect path with `tool === undefined` (the
  executor then produced a `TypeError` "result" as if the effect had been
  attempted). A tool that no longer exists must leave the invocation
  **interrupted**, because its external outcome is unknown.

Repair:

```ts
if (!cancelled && tool !== undefined && call.replay === "safe" && tool.replay === "safe")
```

The rest of the recovery ordering in this file was already correct and is kept:
`clearReplayCheckpoint` is awaited (checkpoint cleared, `materialize()` returns the
persisted args) *before* `performToolInvocation`, and `publishToolOutcome` only
runs after `performToolInvocation` resolves, i.e. after the external effect and
`progress.drain()` (durable progress) have finished.

## 2. `packages/agent/src/harness/execution/tools.ts` (executor / consumer)

`executeToolCall` executed the tool with the *original model* arguments:

```ts
const result = await call.tool.execute(call.toolCall.id, call.toolCall.arguments, …)
```

`ClearedToolCall` carries three things — the model `toolCall`, the resolved
`tool`, and the `args` that survived preparation, hook patching, and (on recovery)
were read back from the durable checkpoint. Handing `toolCall.arguments` to the
effect discarded the cleared/persisted arguments entirely, so a replay ran with
stale model input. Repair: pass `call.args`.

## 3. `packages/agent/src/harness/execution/effect-gate.ts` (admission)

`gate.admit` never consulted the gate state:

```ts
admit<T>(invoke: () => T): T {
    return invoke();          // ← regression
}
```

`BeginAbort`/`close` only mutated the internal state and (for `close`) an
`AbortSignal`, so a call admitted after `beginAbort` still entered the effect; only
the `AbortSignal` check inside the effect helper could notice, and that signal is
deliberately *not* aborted until cancellation commits (`signalAbort`). Repair: call
the existing `check()` helper before invoking, so

* `aborting` → throws `AbortRequested(cancellation)` synchronously and never runs
  the effect,
* `closed` → throws the closing error synchronously and never runs the effect,
* `open` → unchanged.

This is the documented contract of the procedure-facing `Gate` ("synchronous
admission capability") and matches the existing hook pipeline, which relies on
`gate.admit` refusing work once the gate leaves `open`.

## Resulting cross-module behavior (asserted by `.prale-eval/regression.mjs`)

| Scenario | Observable result |
| --- | --- |
| persisted `safe` + tool `safe` | checkpoint cleared → effect invoked with `persisted-arguments` → drain → publish |
| persisted `safe`, tool `never` | no `clear`, no `invoke`; interrupted outcome keeps checkpoint evidence |
| persisted `never`, tool `safe` | same — both declarations must authorize |
| tool missing | no `clear`, no `invoke`; interrupted outcome keeps checkpoint evidence |
| cancelled | no `clear`, no `invoke`; interrupted outcome |
| gate `aborting` | no `invoke`, no effect; interrupted outcome published after the drain |
| gate `closed` | admission refuses with the closing error; no effect |

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` — passes on the repair,
and fails with a plain `node:assert/strict` `AssertionError` (never a crash, import
error or timeout) when any one of the three files is restored to its faulty
baseline:

* `runtime/drive/tools.ts` → "unsafe persisted declaration: the tool effect must not run"
* `execution/tools.ts` → "the executor must run with the cleared/persisted arguments"
* `execution/effect-gate.ts` → "an aborting gate must refuse admission: […]"

No temporary files are required: the harness builds its session/checkpoint state in
memory and drives all asynchronous ordering with explicit promises (no timers,
randomness, network, or credentials).
