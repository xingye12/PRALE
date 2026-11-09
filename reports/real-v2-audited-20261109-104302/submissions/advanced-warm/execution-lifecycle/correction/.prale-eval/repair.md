# Repair: allow safe recovery without corrupting patched outcomes

Task: `advanced/execution-lifecycle/correction` — repository `earendil-works/pi`.

## Producer / consumer flow

```
recoverToolInvocation            (runtime/drive/tools.ts)      producer: decides replay vs. interruption
  -> clearReplayCheckpoint / readCheckpoint                    durable intent boundary
  -> performToolInvocation
       -> executeToolCall         (execution/tools.ts)         consumer: admits the effect through the gate
            -> gate.admit         (execution/effect-gate.ts)   admission policy
       -> lane.hooks.runToolWithGate("after_tool")             admitted hook patch
       -> finalizeToolCall        (execution/tools.ts)         consumer: merges executed output + patch
  -> publishToolOutcome                                        durable outcome + transcript message
```

Three independent defects sat on this single path, one per module. Each is repaired in place; no API,
signature, event shape or unrelated behaviour changed.

### 1. `packages/agent/src/harness/runtime/drive/tools.ts` (producer)

`recoverToolInvocation` guarded the replay branch with `if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe")`.
The constant `false` made every recovered `effect_pending` call fall through to `readCheckpoint` and publish an
`interruptedOutcome`, so a legally replayable effect was permanently reported as "outcome is unknown" and the
tool never ran again. That is the consumer-visible half of the incident: the drive layer never produced the
replayed effect that the executor and finalizer are supposed to consume.

Repair: restore the guard as `!cancelled && call.replay === "safe" && tool !== undefined && tool.replay === "safe"`.
The explicit non-undefined term keeps the type contract of `ClearedToolCall.tool` honest (an unavailable
declaration must degrade to an interruption, not a crash). The policy is therefore exactly the clarified one:
non-cancelled safe/safe replays resume from the persisted intent; a cancelled call, an unsafe persisted
intent, an unsafe/absent declaration, or a missing tool all stay on the checkpoint-evidence interruption path,
and the existing `recovery: true` event markers are preserved on both paths.

### 2. `packages/agent/src/harness/execution/effect-gate.ts` (admission policy)

Two coupled faults in `createGate`:

* `close()` started with `if (state.status !== "open") return;`, so closing a gate that was already `aborting`
  was silently ignored: the terminal error vanished and `admit()` kept throwing the stale `AbortRequested`
  carrying a pending cancellation promise.
* `check()` tested `aborting` before `closed`, encoding the same wrong precedence for admissions.

Repair: `close()` now only ignores an already-`closed` gate (`if (state.status === "closed") return;`) and
otherwise installs `{ status: "closed", error }`, aborting the admission signal with that error when it is not
already aborted; `check()` now tests `closed` first. Consequently a terminal closure made while a cancellation
is pending is authoritative for every later admission, while `beginAbort`/`signalAbort` remain no-ops after a
closure (a pending cancellation can no longer reopen or override it). Closing an open gate, the first close
winning over a later close, and the aborting-only `AbortRequested` path are unchanged.

### 3. `packages/agent/src/harness/execution/tools.ts` (consumer / finalizer)

`finalizeToolCall` computed `isError: patch?.isError || executed.isError`, which is falsy-coalescing: an
after-tool hook that explicitly returned `isError: false` could never clear a failed effect, so the hook's
intent was silently corrupted on the way to the durable `toolResult` message.

Repair: `isError: patch?.isError === undefined ? executed.isError : patch.isError` (the same "`undefined`
means unspecified" convention the hook aggregator in `hooks.ts` already uses). The rest of the merge is
untouched and still preserves every unspecified field: `content` (including an explicit `[]`), `details`,
`usage`, and `terminate` are copied over the executed result field by field, so explicit `false`/empty values
are applied and omitted ones fall back to the real execution output.

## Cross-module consequence

After the repair the three layers agree on one lifecycle: the drive layer resumes a non-cancelled safe/safe
effect from its persisted arguments and clears the intent before re-entering the effect; the gate then either
admits it, aborts it as a cancellation, or fails it with the terminal error of a closed gate; and the finalizer
applies the after-tool patch field by field — including an explicit `isError: false` — while keeping usage and
any field the hook did not mention. Restoring any single file to its baseline breaks exactly this chain, which
is what `.prale-eval/regression.mjs` pins.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` — 15 scenarios, all passing, using
`node:assert/strict` assertions and promise-controlled ordering only. Mutation checks performed during
development (each faulty baseline restored alone, then reverted) each produced a real `AssertionError`:

* drive baseline (`if (false && ...)`) → `expected checkpoint clear, saw read,publish` (no `invoke`, interrupted outcome).
* execution baseline (`||`) → `true !== false` on the cleared-`isError` message.
* gate baseline (`!== "open"` return + aborting-first `check`) → admissions still surfaced `AbortRequested`
  instead of the `terminal-failure` error.

No dependencies, network, credentials, real time or randomness are involved.
