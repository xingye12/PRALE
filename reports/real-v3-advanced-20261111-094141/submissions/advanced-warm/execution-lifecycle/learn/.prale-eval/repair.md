# Repair: recovery authorization must survive effect admission

## Incident

A restored `tools` operation (`assistant.toolCall* -> tools.effect_pending`) was replayed even when
recovery was not authorized, and the replayed effect received the stale model arguments instead of
the arguments that were durably cleared before the original invocation.

Three defects combined across three modules; each one alone is enough to execute an unsafe effect.

## 1. Admission gate never checked its own state

`packages/agent/src/harness/execution/effect-gate.ts`

`createGate()` owns a `check()` helper that throws `AbortRequested` while a cancellation is in
flight and rethrows the owner error once the gate is closed. `gate.admit()` — the only
procedure-facing admission point used by tool execution and by the hook pipeline — simply called
`invoke()` and never consulted `check()`, so admission only failed if the abort *signal* had already
been fired. Cancellation is signalled later than the durable cancellation marker, so an effect could
start inside that window, and a closed gate did not stop an in-flight recovery pass at all.

Repair: `admit()` calls `check()` before running the effect. This preserves the two-phase
cancellation contract (the signal still lags the durable marker) while making admission fail closed.

## 2. Executor used the model arguments, not the cleared arguments

`packages/agent/src/harness/execution/tools.ts`

`executeToolCall()` received a `ClearedToolCall` that carries the validated/cleared `args` next to
the original provider `toolCall`, but invoked `tool.execute(id, call.toolCall.arguments, …)`. Any
argument that was normalized, replaced by a `before_tool` decision, or — critically — reloaded from
the durable argument checkpoint during recovery was ignored and the model's original arguments were
executed instead.

Repair: the executor passes `call.args`, so the single value that was validated, persisted, and
cleared is the value that crosses the external effect boundary.

## 3. Recovery admission accepted a single replay declaration (and missing tools)

`packages/agent/src/harness/runtime/drive/tools.ts` (`recoverToolInvocation`)

Recovery replayed an interrupted call when *either* the durable checkpoint declared
`replay: "safe"` *or* the currently configured tool declared `replay: "safe"`. That is weaker than
the producer contract: `publishToolIntent` persists `tool.replay ?? "never"` for the specific tool
that was about to run, so the durable declaration is authoritative and a later configuration must
not be able to widen it (and an earlier one must not be narrowed away). `tool?.replay` also left the
missing-tool case admitted: with `call.replay === "safe"` and no tool in the current config the call
was replayed with `tool === undefined` and only failed inside the executor.

Repair: replay requires `tool !== undefined && call.replay === "safe" && tool.replay === "safe"`.
Everything else stays on the interrupted path, which reads the durable checkpoint and publishes the
interruption marker while keeping the last durable progress snapshot.

The surrounding ordering in the same file was verified and is covered by the regression:

* `clearReplayCheckpoint` deletes the old `pi.pending.tool_output` checkpoint (and emits the
  recovery `tool_start` with the persisted arguments) *before* the effect is invoked;
* the outcome is published by `performToolInvocation(...).then(publishToolOutcome)`, i.e. only after
  the effect resolves, after the live-update delivery drains, and after the durable progress channel
  drains.

## Cross-module chain

```
tool.placements -> drive/tools.recoverToolInvocation   (authorization: both declarations + tool exists)
                     |-- clearReplayCheckpoint         (durable args read, old checkpoint cleared)
                     |-- effect-gate.admit             (cancellation/closed refusal, no effect starts)
                     |-- execution/tools.executeToolCall (effect runs with cleared args)
                     `-- publishToolOutcome            (staged only after effect + drain)
```

## Regression

`.prale-eval/regression.mjs` links the real `execution/effect-gate.ts`, `execution/tools.ts`,
`session/values.ts`, `session/types.ts`, `session/commit.ts`, `runtime/progress.ts`,
`runtime/drive/tool-placement.ts` and `runtime/drive/tools.ts` through the vm graph, with boundary
fakes only for `validateToolArguments`, `withAbortSignal`, `SessionInvariantError` and a minimal
durable `Lane`/`Drive` pair. Async ordering is controlled with promises (no timers, randomness or
network).

Cases: gate refusal while aborting; gate refusal after close; executor uses cleared arguments; no
effect on refused admission; safe double-declaration replay with persisted arguments, checkpoint
clear and publish ordering (cleared before invoke, progress during effect, outcome published exactly
once after effect, progress and update delivery); interruption for tool-only safe, checkpoint-only
safe, missing tool; interruption when cancellation wins admission; no effect through a closed gate.

Each faulty baseline was restored alone to confirm detection:

| file restored to baseline | result |
| --- | --- |
| `runtime/drive/tools.ts` | detected (ordering/execution assertions fail) |
| `execution/effect-gate.ts` | detected (`Missing expected exception`) |
| `execution/tools.ts` | detected (deep-equal on executed arguments) |

Additional temporary probes confirmed detection for the other incident clauses inside
`runtime/drive/tools.ts`: removing the checkpoint delete before replay, and publishing the outcome
before the effect finishes were both detected.
