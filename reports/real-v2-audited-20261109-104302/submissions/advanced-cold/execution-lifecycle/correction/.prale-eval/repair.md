# Safe recovery and patched outcomes

## Symptom

Three independent faults broke the recovery path of the tool-execution lifecycle:

1. A finished tool effect that was interrupted by a process restart could never be replayed, even when both the
   persisted intent row and the declared tool were `replay: "safe"` and no cancellation was pending. Every recovered
   call degraded to the "interrupted" checkpoint outcome.
2. An after-tool hook that explicitly returned `isError: false` could not clear a tool failure; the failure was
   re-asserted whenever the executed call had failed. Only truthy patch values were honored, so an explicit `false`
   (and any falsy patch value) was silently replaced by the executed value.
3. Closing an effect gate with a terminal error while a cancellation was still pending was a no-op, and the pending
   cancellation kept refusing admissions. The drive pass therefore reported an abort (`AbortRequested`) instead of the
   terminal error that actually terminated the run.

## Producer/consumer flow

`runtime/drive/tools.ts` (`recoverToolInvocation`) decides *whether* a durable `effect_pending` call may be re-driven;
it is the producer of the recovery decision. It hands the persisted arguments to `execution/tools.ts`
(`executeToolCall` -> `gate.admit`) and consumes the finalized outcome through `finalizeToolCall` /
`createToolResultMessage`. `execution/effect-gate.ts` is the single admission authority used by both the tool effect and
the after-tool hook admission, so a gate that hides its terminal closure leaks a stale cancellation into every
consumer downstream.

## Fixes (one line each)

- `packages/agent/src/harness/runtime/drive/tools.ts`: removed the dead `false &&` guard so the safe/safe branch is
  reachable again. The replay condition is now exactly the policy: not cancelled, persisted `replay === "safe"`, and
  declared tool `replay === "safe"`. The effect is re-driven from the cleared durable intent (`clearReplayCheckpoint`
  supplies the persisted arguments) and the checkpoint path stays in place for every other combination.
- `packages/agent/src/harness/execution/tools.ts`: `finalizeToolCall` now merges `isError` with `??` instead of `||`,
  so an explicit `false` wins over the executed failure while an omitted (`undefined`) patch value still falls back to
  the executed flag. Content/details/usage/terminate already used explicit `undefined` checks, which keeps unspecified
  fields, extra result keys and usage intact while applying explicit empty (`[]`) or falsy patch values.
- `packages/agent/src/harness/execution/effect-gate.ts`: `close` now transitions a gate that is already `aborting`
  into `closed` (only an already closed gate is ignored). The terminal error is recorded as the authoritative state and
  as the abort reason, so future admissions throw the terminal error rather than `AbortRequested`, and a later
  `beginAbort` cannot downgrade the closure. `close` on an `open` gate, the first-error-wins rule and
  `signalAbort()`'s aborting-only behavior are unchanged.

No public API, type, or unrelated behavior changed; the diff is three single-line edits.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` links the real modules through the read-only
`.prale-eval/subject.mjs` helper (only checkpoint storage, progress transport, hook delivery and provider imports are
fakes) and asserts observable behavior with uncaught `node:assert/strict` assertions:

- gate: open admission; `AbortRequested` carrying the pending cancellation; terminal closure over a pending
  cancellation being authoritative (error identity, abort reason, no downgrade by a later `beginAbort`/`close`).
- execution: explicit `isError: false` clearing a failure, explicit empty `content` and explicit `null` details being
  applied, and details/usage/extra result keys preserved when unspecified.
- drive: non-cancelled safe/safe recovery replays through the real executor with the persisted arguments and no
  interruption marker; cancelled, `never`-declared, `never`-persisted and missing-tool cases stay on the checkpoint
  path; progress updates/checkpoints are delivered before publication.
- boundaries: a closed gate rejects a replay with the terminal error; a cancellation that wins admission does not
  replay; closing an aborting gate mid-invocation makes the terminal error authoritative for the after-tool admission.

Local fixtures are created in a temporary directory under `.prale-eval/` and removed in a `finally` block. Restoring
each of the three modules to its faulty baseline individually was verified to fail the same script with an assertion
error (never a crash, import error or timeout), and the repair passes. Ordering is driven only by promises; no real
time, randomness or external services are used as evidence.

Limitation: the repository's own Vitest/TypeScript toolchains are not installed in this workspace (no `node_modules`,
and no dependency installation is permitted), so the focused harness script above is the only executed validation.
