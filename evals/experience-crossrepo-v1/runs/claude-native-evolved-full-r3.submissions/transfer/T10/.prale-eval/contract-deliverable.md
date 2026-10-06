# T10 — Contract: a failed effect leaves a retryable intent, not a terminal success

Repository: `pi` · Mode: `contract` · Execution path under contract: the durable tool
drive path (`packages/agent/src/harness/runtime/drive/tools.ts`) over the shared
execution primitives (`packages/agent/src/harness/execution/tools.ts`).

## 1. What the contract guarantees

The primitive-path acceptance contract lives in
`packages/agent/test/harness/execution-tools.test.ts`. This task transfers that
guarantee to the **different tool/execution path** — the durable drive procedure that
wraps the primitives with an intent/outcome protocol — and states it as a checkable
contract:

| # | Invariant | Where it is enforced |
|---|-----------|----------------------|
| C1 | **Intent before effect.** The retryable `effect_pending` intent (with its `replay` policy and persisted arguments) is durably committed *before* the external effect is admitted. | `drive/tools.ts` `publishToolIntent` (187–227), called by `startToolInvocation` (475–513, intent at 489 precedes the effect at 503) |
| C2 | **Failure is not success.** A tool effect that throws synchronously or asynchronously is normalized to in-band error output (`isError: true`); it never escapes and is never recorded as a success. | `execution/tools.ts` `executeToolCall` (124–158, catch → `isError: true`), asserted in `execution-tools.test.ts` 151–171 |
| C3 | **Refusal is not success.** When the effect gate refuses admission, `AbortRequested` escapes and the effect is never invoked. | `effect-gate.ts` `createGate`/`Gate.admit`, asserted in `execution-tools.test.ts` 173–183 |
| C4 | **Interruption stays retryable.** A persisted `effect_pending` recovered after a restart is either safely replayed (retry) or recorded as an error with an *unknown external outcome* — never materialized as a terminal success. | `drive/tools.ts` `recoverToolInvocation` (515–540), `publishToolOutcome` (229–293), asserted in `drive-tools.test.ts` 419–481 |
| C5 | **No outcome without a prior intent.** The durable layer observes `intent_commit` strictly before `tool_start` and `outcome_commit`; a cancelled effect stages a **non-terminating** `isError` result. | `drive-tools.test.ts` `ObservedMemoryStorage` (72–96), assertions at 363–372 and 702–759 |

The normalized operation result below is the machine-readable shape of a single tool
effect under this contract.

```jsonc
{
  "operation": "tool.effect",
  "intent":  { "status": "effect_pending", "replay": "safe" | "never" },  // durable, retryable
  "outcome": { "status": "outcome_ready", "isError": true },              // terminal record, only after execution
  "terminalSuccess": false        // MUST be false when the effect threw, was refused, or was interrupted
}
```

## 2. Executable demo

`.prale-eval/contract-demo.mjs` is a dependency-free Node script that verifies the
contract from two angles.

**Behavioral** — it imports the *real*, import-free effect gate
(`packages/agent/src/harness/execution/effect-gate.ts`) and drives it directly:

- an admitted effect runs and returns its value;
- with `beginAbort` in effect, `Gate.admit` throws `AbortRequested` **and the effect is
  never invoked** (C3);
- a closed gate throws its terminal error and still never invokes the effect.

**Static** — it reads the cited sources and asserts the ordering/outcome invariants
C1, C2, C4 (intent `effect_pending` carries a replay policy and persists args;
`publishToolIntent` precedes `performToolInvocation`; recovery is
safe-replay-or-unknown; `executeToolCall`'s catch returns `isError: true`).

### How to run

```sh
node .prale-eval/contract-demo.mjs
```

### Observed result (this workspace)

```
passed: 9   failed: 0
ALL 9 CONTRACT CHECKS PASSED
```

## 3. Validation notes and limitations

The canonical focused command for the required acceptance file is:

```sh
npx --no-install vitest run packages/agent/test/harness/execution-tools.test.ts \
  --config packages/agent/vitest.harness.config.ts
```

This workspace ships **no `node_modules`** — `npx` fails with
`ERR_MODULE_NOT_FOUND` for the `vitest` CLI, and installing dependencies is out of
scope for this task. That limitation is recorded in
`.prale-eval/result.json` → `validation`. The executable demo above is the strongest
focused validation available without the test runner: it exercises the real
`effect-gate.ts` module at runtime and grounds the remaining invariants in the cited
source and acceptance-test lines.
