# Recovery authorization must survive effect admission

## Failure chain

Recovery of an interrupted tool call runs through three production modules. The
faulty baseline broke the authorization chain at every hop, so an interrupted
operation whose durable intent was *not* replayable was executed anyway, and it
was executed with the stale arguments of the original model response instead of
the arguments that were persisted with the durable intent.

| Hop | Module | Fault | Repair |
| --- | --- | --- | --- |
| Authorization | `packages/agent/src/harness/runtime/drive/tools.ts` (`recoverToolInvocation`) | Replay was admitted when *either* the durable `call.replay` declaration or the currently registered `tool.replay` declaration was `"safe"` (`a \|\| b`), and a tool that was no longer registered made `tool?.replay` `undefined`, so any `call.replay === "safe"` intent still crossed the effect boundary. | Both declarations must be `"safe"`, and the tool must still be registered (`!cancelled && tool !== undefined && call.replay === "safe" && tool.replay === "safe"`). Everything else stays interrupted: the durable checkpoint is read and an interruption outcome is published, and the old checkpoint is never cleared. |
| Admission | `packages/agent/src/harness/execution/effect-gate.ts` (`createGate(...).gate.admit`) | `admit` invoked the procedure without consulting the gate state, so an aborting or closed gate still admitted the external effect. | `admit` performs the existing `check()` first: an aborting gate throws `AbortRequested` (carrying the cancellation promise) and a closed gate throws its stored fault before any effect can start. `Gate`/`GateControl` APIs are unchanged; the abort signal is still only signalled after cancellation commits. |
| Effect | `packages/agent/src/harness/execution/tools.ts` (`executeToolCall`) | The executor passed `call.toolCall.arguments` — the raw model arguments — to `tool.execute`, discarding `call.args`, which for a recovered call are the cleared/persisted arguments. | The executor now passes `call.args` (the cleared, validated arguments) while still using `call.toolCall.id` for identity, so prepared/hook-replaced/recovered arguments are the ones that reach the tool. |

## Ordering that is now guaranteed

`recoverToolInvocation` clears the previous checkpoint (`clearReplayCheckpoint`
deletes the pending tool-output snapshot and reads the persisted arguments)
*before* `performToolInvocation` is entered. `performToolInvocation` seals and
awaits the durable progress channel (`progress.drain()`) before the after-tool
hook runs and before the outcome is published; `publishToolOutcome` is chained
after the invocation promise resolves. So the observable recovery sequence is:

```
clear -> invoke -> (updates/checkpoints) -> effect-complete -> seal -> drain -> drain-complete -> publish
```

A cancelled recovery, an unsafe declaration on either side, a missing tool, or
an aborting gate produces `read -> publish` with an interrupted (error) outcome
that preserves the durable progress snapshot and the explicit interruption
marker, and with no `clear` and no `invoke`.

## Validation

`.prale-eval/regression.mjs` loads the real modules through the read-only
`.prale-eval/subject.mjs` helper and asserts cross-module behaviour only (checkpoint
storage, progress transport and the outcome publisher are boundary fakes).

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

Each faulty baseline was restored in isolation and the script failed with an
uncaught `node:assert/strict` assertion (never a crash, import error or timeout):

* `effect-gate.ts` restored -> `an aborting gate must refuse effect admission`.
* `execution/tools.ts` restored -> `the executor must invoke the tool with the persisted arguments`
  (`raw-model-arguments` vs `persisted-arguments`).
* `runtime/drive/tools.ts` restored -> `tool declared replay never: tool effect must not be admitted`.

No temporary inputs are needed by the script, so there is nothing left behind in
`.prale-eval/`.
