# Contract: an operation's effect is unobservable before durable intent settlement

Task: `learn/03` — repository `pi`, mode `contract`.
Artifact: `packages/agent/test/harness/durable-intent-settlement.test.ts` (new, minimal).

## The contract

For every tool-backed operation the harness must durably record *what it is about to do*
before it does it. Concretely, the effect boundary is only crossed after the intent is settled:

1. `prepareToolCall` resolves the tool, applies deterministic argument preparation and validates
   the result. This step is pure.
2. `applyBeforeToolDecision` turns the prepared call into a `ClearedToolCall` — a call that is
   *cleared for durable intent publication and execution* (`src/harness/execution/tools.ts`, line 30).
   Still no effect.
3. `startToolInvocation` `await`s `publishToolIntent`, which commits the cleared arguments and the
   `effect_pending` state to the durable session
   (`src/harness/runtime/drive/tools.ts`, lines 489–499).
4. Only then does the completion run `performToolInvocation` → `executeToolCall`, whose whole body is
   wrapped in `gate.admit(async () => { … call.tool.execute(…) })`
   (`src/harness/execution/tools.ts`, lines 134–138).
5. If settlement answers `cancel_requested`, the effect is skipped and an `abortedOutcome` is
   published instead (line 502).

Observable consequence: an operation's effect (the tool body, and any result derived from it)
cannot be observed before the durable intent has settled. The public snapshot expresses the same
rule — `LaneSnapshotTool` (`src/harness/agent-harness.ts`, lines 194–209) makes `result` optional
while `status: "running"` and guarantees it only for `status: "settled"`.

## The executable demo / test

File: `packages/agent/test/harness/durable-intent-settlement.test.ts`.

It uses the same exported primitives as the existing
`packages/agent/test/harness/execution-tools.test.ts` so it stays minimal and independent of a full
session:

- `clearedCall()` runs `prepareToolCall` + `applyBeforeToolDecision`, i.e. exactly the harness's
  pre-effect clearing step (no tool body runs).
- Case 1 — *keeps the tool effect unobservable until the durable intent settles*: a settlement
  promise stands in for `publishToolIntent`. The tool body records whether the durable intent exists
  when it runs (`effect:before-settlement` vs `effect:after-settlement`). While settlement is
  outstanding, the observation log is empty and `execute` has not been called. After
  `settleIntent()` resolves, the recorded order is exactly
  `["settled:effect_pending", "effect:after-settlement"]`, `execute` ran once, and the executed
  result is the settled call's output. A `effect:before-settlement` marker would fail the test.
- Case 2 — *never observes the effect when durable intent settlement fails*: the gate owner closes
  the gate before admission (`control.close(...)`). `executeToolCall` refuses entry, the failure
  propagates, and the tool body is never invoked.

## How to run it

```sh
npm --prefix packages/agent run test:harness -- --run test/harness/durable-intent-settlement.test.ts
```

## Validation status

- Focused vitest run: **blocked** — the checkout has no installed dependencies
  (`vitest: not found`, exit 127) and installing dependencies is out of scope.
- Fallback executed: `node --experimental-strip-types --check packages/agent/test/harness/durable-intent-settlement.test.ts`
  → exit 0 (the file parses as valid TypeScript under Node 24.14.0).
- Static import check passed against the checkout (all imported symbols exist and are exported from
  the cited modules). The test still needs to be executed under vitest once dependencies are
  installed.

## Invariants this pins

- No tool body entry before durable intent settlement.
- Exactly one effect per settled intent.
- Failed settlement never enters the effect.
