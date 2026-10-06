# Contract: durable intent → effect → settlement (pi)

Repository key: `pi` · task `29` · mode `contract`

This deliverable states the contract that the pi agent harness uses to model one
operation as **durable intent → effect → settlement**, including how a *failed
effect* is handled. It is backed by an executable demo and by source citations in
`.prale-eval/result.json`.

## The normalized operation result

The canonical normalized result is pi's `OperationResultRecord`
(`packages/agent/src/harness/session/types.ts:107-117`), built by
`operationResultRecord()` (`.../runtime/drive/terminal.ts:63-82`):

```ts
interface OperationResultRecord {
  operationId: string;
  kind: "run" | "compaction" | "navigation";   // from OperationMeta.intent.kind
  status: "completed" | "declined" | "aborted" | "failed"; // TerminalStatus
  error?: OperationError;                       // { code, message, details? }
  fromTipId: string | null;
  tipId: string | null;
  startedAt: number;
  endedAt: number;
}
```

**Contract invariant.** An error is present *iff* the operation failed:

```ts
if ((status === "failed") !== (error !== undefined)) {
  throw new SessionInvariantError("Only a failed operation result may carry an error");
}
```

This is the whole of the failed-effect handling rule at the settlement boundary:
a failed effect is data (`status: "failed"` + `OperationError`), and a
non-failed settlement can never smuggle an error.

## The three legs

| Leg | Durable carrier | Public harness surface |
| --- | --- | --- |
| **Intent** | `OperationMeta.intent` (`session/types.ts:75-90`) | `AgentLane.accept(OperationRequest)` → `OperationAdmission` (`agent-harness.ts:119-134`, `111-117`) |
| **Effect** | `*.effect_pending` leaves (`session/types.ts:263-270`), `ToolCall.status: "effect_pending"` (`:160`), retry via `*.retry_wait` (`:272-274`) | `AgentLane.drive(DriveOptions)` → `DriveOutcome` (`agent-harness.ts:165-169`) |
| **Settlement** | `OperationResultRecord` (`session/types.ts:107-117`) | `AgentLane.getResult(operationId)` (`agent-harness.ts:538-580`); `run_end` event (`:255-263`); `RunResult` (`:84-87`) |

1. **Intent.** An `OperationRequest` (prompt, skill, prompt_template, compaction,
   navigation) is admitted by `accept()` and receipted as
   `OperationAdmission { operationId, kind, startedAt }`. Admission can fail
   *before* any effect (e.g. `LaneBusy`), so rejected intent costs nothing.
   The accepted intent is persisted as `OperationMeta` inside the durable
   `OperationState` union (`session/types.ts:315-329`).

2. **Effect.** `drive()` advances the operation. A dispatched non-idempotent
   request (model response, deferred handle, summary generation, tool call) is
   recorded as an `effect_pending` leaf *before* its outcome is known. The
   returned `DriveOutcome` is either `settled` (carrying the terminal
   `OperationResultRecord`) or `waiting` — `reason: "retry"` with `notBefore`, or
   `reason: "deferred"` with a `DeferredHandle`. `AgentHarness.create()` returns
   `open: OpenOperation[]` so a restarted harness rehydrates in-flight effects
   (`agent-harness.ts:614-622`).

3. **Settlement.** Exactly one terminal transaction writes the immutable
   `OperationResultRecord` and emits `run_end`/`compaction_end`/`navigation_end`.
   The `run_end` variant is discriminated so that `completed`/`aborted` declare
   `error?: never` while `failed` **requires** `error: OperationError`
   (`agent-harness.ts:255-263`).

## Failed effect handling

A failed effect has two durable outcomes, both handled without a raw throw:

- **Retryable** — the operation transitions to a `retry_wait` leaf
  (`assistant.retry_wait` / `summary.retry_wait`), carrying
  `RetryWait { nextAttempt, notBefore, errorMessage }`
  (`session/types.ts:203-207, 272-274`). The failure is *persisted*; the next
  `drive()` resumes the operation without replaying the finished effect. The
  demo shows two such leaves before the third attempt settles as `completed`.
- **Terminal** — the operation settles once as `status: "failed"` with an
  `OperationError { code, message, details? }`, recorded on both the
  `OperationResultRecord` and the `run_end` event, and the durable operation
  state is removed by `operationCleanupWrites()`
  (`.../runtime/drive/terminal.ts:26-61`).

Admission-time failures use a separate channel: `RunResult` is
`Result<OperationResultRecord | SuspendedRun, LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed>`.
So intent rejection (`Result.err`) never masquerades as a failed effect.

## Executable demo

`.prale-eval/operation-pipeline.demo.ts` — run with:

```sh
node .prale-eval/operation-pipeline.demo.ts
```

It imports the repository's real `Result` and `LaneBusy` at runtime (Node 24
type stripping, no build/deps) and its operation types type-only, then models
four scenarios through a `runOperation(intent, effectPlan, options)` driver that
emits the same normalized record shape as `OperationResultRecord`:

| Scenario | Journal | Settlement |
| --- | --- | --- |
| success | `effect_pending → outcome_ready` | `status: "completed"`, `tipId: "tip-1"` |
| retryable failure | `effect_pending → retry_wait → effect_pending → retry_wait → effect_pending → outcome_ready` | `status: "completed"`, `tipId: "tip-3"` |
| terminal failure | `effect_pending → outcome_ready(error)` | `status: "failed"`, `error: { code: "provider_error", message: "upstream 500" }` |
| abort | — | `status: "aborted"`, no `error` |

It also reuses the repo's own guards: a busy-lane admission is rejected with the
real `LaneBusy` tagged error, and a `failed` settlement constructed without an
error is rejected by the same invariant `operationResultRecord()` enforces.

Observed output (exit 0):

```text
{"operationId":"op-ok","kind":"run","status":"completed",...,"tipId":"tip-1",...}
{"operationId":"op-retry","kind":"run","status":"completed",...,"tipId":"tip-3",...}
{"operationId":"op-fail","kind":"compaction","status":"failed","error":{"code":"provider_error","message":"upstream 500"},...}
{"operationId":"op-abort","kind":"navigation","status":"aborted",...}
admission rejected before any effect: LaneBusy op-ok
failed settlement without error rejected by invariant: true
OK: 4 settlements modeled, 2 durable retry leaf(s)
```

## Validation

See the `validation` object in `.prale-eval/result.json`. `node_modules` is not
present in this workspace, so the workspace `vitest`/`tsgo` suites could not be
run; validation is the self-contained Node execution above plus grep-level
verification that each cited symbol lies inside its declared line range.
