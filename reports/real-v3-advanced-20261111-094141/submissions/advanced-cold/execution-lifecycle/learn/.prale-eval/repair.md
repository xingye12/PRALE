# Repair: recovery authorization must survive effect admission

## Incident

After a crash, recovery of a durable tool batch re-executed an interrupted call whose
durable declaration was **not** replay-safe, executed it with the *original model*
arguments instead of the arguments that had been cleared/persisted at intent time, and
admission-time cancellation (or a closed drive gate) could not stop the effect at all.
The authorization-to-effect chain was broken in three places across three modules:

| Module | Defect | Consequence |
|---|---|---|
| `packages/agent/src/harness/runtime/drive/tools.ts` | `recoverToolInvocation` authorized replay with `call.replay === "safe" \|\| tool?.replay === "safe"` | either declaration alone authorized re-execution; an implementation that had disappeared from the current registry (`tool === undefined`) was also admitted and crossed the effect boundary |
| `packages/agent/src/harness/execution/effect-gate.ts` | `Gate.admit` invoked the operation without checking the gate state | `beginAbort`/`close` could not prevent admission; the cancellation marker or the close error only reached an already-started effect through the abort signal |
| `packages/agent/src/harness/execution/tools.ts` | `executeToolCall` passed `call.toolCall.arguments` to `tool.execute` | the stale model arguments (and any `prepareArguments`/`before_tool` replacement) were ignored, so a safe replay re-ran with untrusted/cleared-away arguments |

## Cross-module fix

1. **Authorization (producer side).** `recoverToolInvocation` now requires the *full*
   conjunction: `!cancelled && tool !== undefined && call.replay === "safe" && tool.replay === "safe"`.
   The durable declaration recorded at intent time and the declaration of the tool
   implementation currently registered must *both* be `safe`; a missing implementation,
   a stored `never`, or a tightened current declaration falls through to the interruption
   branch, which reads the durable progress checkpoint and stages a synthetic,
   non-terminating error (checkpoint content/details/usage preserved, explicit
   "external outcome is unknown" warning, no `after_tool`, no `tool_start`).
2. **Admission (gate).** `Gate.admit` performs the single synchronous state check and
   then invokes: `aborting` throws `AbortRequested(cancellation)` (so the caller can wait
   for the durable cancellation before reconciling) and `closed` throws the closing error,
   with `invoke` never running. The abort signal is still only pulled after the marker
   commits (`signalAbort`), so admission-first ordering is unchanged.
3. **Effect (consumer side).** `executeToolCall` executes with `call.args` — the cleared,
   validated arguments carried by `ClearedToolCall` (the same value that was persisted
   under `pi.op.tool_args` by the intent commit and that safe replay re-reads after
   clearing the checkpoint) instead of the raw model arguments.

The already-correct ordering is preserved and now actually reachable end to end:
`clearReplayCheckpoint` (checkpoint deletion + recovery-tagged `tool_start` publishing the
persisted arguments) commits *before* the effect starts, and the outcome is only staged
and published after the effect resolved, the latest live `tool_update` delivery resolved,
and the durable progress channel drained. `after_tool` still runs with `cleared.args`.
No public API, durable address, event union, or unrelated behavior changed.

## Validation

`.prale-eval/regression.mjs` links the real production modules
(`effect-gate.ts`, `execution/tools.ts`, `runtime/drive/tools.ts`, `runtime/progress.ts`,
`session/values.ts`) in one `createGraph` realm and supplies its own boundary fakes:
an in-memory durable value store behind the Lane mutation line (`command`,
`settleOperation`, `continueOperation`, `emitBatch`), a hook registry, pi-ai argument
validation, the chord `withAbortSignal` helper, and the tool-placement helpers. It drives
the real `recoverToolInvocation` procedure through a trailer export and asserts, across
module boundaries:

- aborting/closed gates refuse admission synchronously (`AbortRequested` carries the
  durable cancellation promise) while an open gate still admits;
- `prepareToolCall` → `applyBeforeToolDecision` → `executeToolCall` hands the cleared
  arguments to the tool, and a gate refusal never starts the effect;
- `safe` + `safe` replay re-executes once with the persisted arguments and the same
  invocation id, with the old checkpoint already deleted and the recovery `tool_start`
  published before the effect;
- `never` + `safe` (stored declaration unsafe) and a missing implementation stay
  interrupted: no effect, no `after_tool`, no `tool_start`, checkpoint content/details
  preserved in the staged error, one recovery-tagged `tool_end`, durable call state
  `outcome_ready`;
- a durable `cancel_requested` control and an aborting gate start no effect;
- nothing is staged or published while the live update delivery / durable progress drain
  is still parked.

Each source file was restored individually to its faulty baseline and the script failed
with an uncaught `node:assert/strict` assertion (never an import error or crash):

| Restored file | Detected assertion |
|---|---|
| `execution/effect-gate.ts` | `aborting gate executed the admitted effect` |
| `execution/tools.ts` | `executor used arguments other than the cleared ones` |
| `runtime/drive/tools.ts` | `an unauthorized interrupted call crossed the effect boundary` |

Limitation: the repository's own `vitest` suites and `tsgo` type check could not be run
because workspace dependencies are not installed in this environment (no network, no
dependency installation permitted); the regression above is the executable validation.
