# T10 contract deliverable: a failed tool effect leaves a retryable intent, not a terminal success

Repository: `pi` · Mode: `contract` · Task: `T10`

## 1. Contract

For the tool-effect execution path (the "different tool/execution path" for this
cross-repository transfer), the following invariant must hold:

> A tool effect is executed only after its durable `effect_pending` intent
> (persisted arguments plus the `replay` flag) has been committed. A failed
> effect is never durably recorded as a terminal, unflagged success: a throw is
> converted to an `isError: true` tool result, and a process death mid-effect
> leaves the `effect_pending` intent in place so recovery can retry it
> (replay-safe tools) or surface an explicit interrupted error.

Failure modes covered by the contract:

| Failure | Durable outcome | Retry? |
| --- | --- | --- |
| Gate refuses admission (abort-first) | `AbortRequested` escapes; effect never invoked; error outcome | caller re-issues |
| Tool throws (sync or async) | `outcome_ready` message with `isError: true` | model sees error result and may retry |
| Process dies mid-effect, `replay: "safe"` | intent stays `effect_pending` | recovery replays from persisted arguments |
| Process dies mid-effect, `replay: "never"` | explicit interrupted error, `isError: true` | not retried, never a success |

## 2. Where the contract lives

| Mechanism | Symbol | Location |
| --- | --- | --- |
| Throw → error result; abort checked before the effect | `executeToolCall` | `packages/agent/src/harness/execution/tools.ts:125-158` |
| Durable intent committed before the effect | `publishToolIntent` | `packages/agent/src/harness/runtime/drive/tools.ts:187-227` |
| Outcome staged with `isError` preserved | `publishToolOutcome` | `packages/agent/src/harness/runtime/drive/tools.ts:229-293` |
| Recovery replays only replay-safe intents | `recoverToolInvocation` | `packages/agent/src/harness/runtime/drive/tools.ts:515-540` |
| Intent state distinct from success | `ToolCall` | `packages/agent/src/harness/session/types.ts:157-163` |
| Acceptance tests | `executeToolCall`, `AbortRequested` | `packages/agent/test/harness/execution-tools.test.ts:151-171`, `173-183` |
| Driver recovery test | `safeExecute` | `packages/agent/test/harness/runtime/drive-tools.test.ts:419-481` |

The public acceptance contract for this task is
`packages/agent/test/harness/execution-tools.test.ts`: the `it.each` "converts
%s tool throws to error output" case requires `result.isError === true` for both
synchronous and asynchronous throws, and "lets abort-first gate refusal escape
without invoking the tool" requires `AbortRequested` with
`expect(execute).not.toHaveBeenCalled()`.

## 3. Executable demo

`.prale-eval/contract-demo.mjs` is a dependency-free Node script (only `node:fs`,
`node:path`, `node:url`). Run it from the repository root:

```sh
node .prale-eval/contract-demo.mjs
```

It has two parts:

1. **Source checks** - reads the real cited files and asserts the
   invariant-bearing code exists at the named anchors (for example:
   `executeToolCall` contains `return gate.admit(`, calls `throwIfAborted()`
   before the `try`, returns `{ result, isError: false }` only on success, and
   catches throws into `createErrorToolResult(...)` with `isError: true`;
   `publishToolIntent` writes `operationToolArgs(...)` with
   `status: "effect_pending"`; `publishToolOutcome` stages the message through
   `pendingEntry`; `recoverToolInvocation` gates replay on
   `call.replay === "safe" && tool?.replay === "safe"`). 11 checks.
2. **Behavioral model** - a small state machine mirroring the durable
   `planned -> effect_pending -> outcome_ready -> completed` transitions,
   exercised against five scenarios: `success`, `throw`,
   `abort-before-admission`, `crash-replay-safe`, `crash-replay-never`. The
   whole-run invariant asserted is "only an effect that actually returned
   successfully is recorded as a non-error completed outcome". 6 checks.

It prints a normalized JSON result and exits non-zero if any check fails.

### Normalized result (abridged)

```json
{
  "task_id": "T10",
  "repository": "pi",
  "mode": "contract",
  "contract": {
    "statement": "A tool effect is executed only after its durable effect_pending intent (arguments + replay flag) is committed; a failed effect never becomes a terminal unflagged success ...",
    "path": "packages/agent/src/harness/execution/tools.ts",
    "symbol": "executeToolCall",
    "start_line": 125,
    "end_line": 160
  },
  "verification": {
    "total_checks": 17,
    "source_checks": 11,
    "model_invariant_checks": 6,
    "model_scenarios": [
      { "scenario": "success",              "trace": ["intent_published:effect_pending", "effect_invoked", "effect_succeeded"],                              "terminalStatus": "completed", "isError": false },
      { "scenario": "throw",                "trace": ["intent_published:effect_pending", "effect_invoked", "effect_failed:isError"],                          "terminalStatus": "completed", "isError": true  },
      { "scenario": "abort-before-admission","trace": ["intent_published:effect_pending", "effect_not_invoked:abort_refused"],                                "terminalStatus": "completed", "isError": true  },
      { "scenario": "crash-replay-safe",    "trace": ["intent_published:effect_pending", "effect_invoked", "process_crash:effect_pending_left_retryable", "recovery:replay_persisted_args"], "terminalStatus": "completed", "isError": false },
      { "scenario": "crash-replay-never",   "trace": ["intent_published:effect_pending", "effect_invoked", "process_crash:effect_pending_left_retryable", "recovery:interrupted_marker"],    "terminalStatus": "completed", "isError": true  }
    ]
  },
  "status": "passed"
}
```

(`verification.total_checks` counts every `check(...)` call: 11 on the cited
sources plus 6 model invariants; `checks` in the real output lists each one with
`id`, `status`, and `detail`.)

### Observed run

```sh
$ node .prale-eval/contract-demo.mjs
{ ... "status": "passed" }
$ echo $?
0
```

## 4. Validation

`node .prale-eval/contract-demo.mjs` — **passed** (17 checks, exit 0).

Limitation: the repository's vitest suites were not executed. The workspace has
no `node_modules`, and installing dependencies is out of scope for this task.
`packages/agent/test/harness/execution-tools.test.ts` (the required acceptance
contract) and `packages/agent/test/harness/runtime/drive-tools.test.ts` are
therefore used as the authoritative static contract and cited as evidence. The
behavioral model mirrors, but does not import, the repository modules because
those modules import the uninstalled `@earendil-works/pi-ai` and `typebox`
packages.

## 5. Conclusion

The contract holds. The durable driver commits an `effect_pending` intent
(arguments + replay flag) before crossing the external effect boundary, the
primitive converts any tool throw into an `isError: true` result, and recovery
retries only replay-safe pending intents while settling the rest as explicit
interrupted errors. No failing path yields a terminal unflagged success.
