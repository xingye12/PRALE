# Repair: live progress, durable progress and errors diverge

Task: `advanced/execution-lifecycle/transfer` — repository `earendil-works/pi`.

## Incident

A recovered tool (an `effect_pending` call replayed through the private recovery
entry `recoverToolInvocation`) emitted live progress, then one explicit
`{ checkpoint: true }` update, then threw. Three separate defects made the
lifecycle diverge across module boundaries:

1. every live update was persisted as durable progress, not just the
   checkpoint-marked one;
2. the tool's exception was published as a *successful* tool result;
3. `control.signalAbort()` never reached the already-admitted tool's
   `AbortSignal`, so an abort could not interrupt in-flight work.

## Cross-module flow and the three repairs

`recoverToolInvocation` (`runtime/drive/tools.ts`) re-clears the persisted
arguments, then hands the call to `performToolInvocation`
(`runtime/drive/tools.ts`), which

* opens the progress channel via `openToolProgress` (boundary),
* calls `executeToolCall` (`execution/tools.ts`) with `drive.gate`
  (`execution/effect-gate.ts`) and an update callback,
* seals the channel, awaits the last observer delivery and `progress.drain()`,
* then publishes the finalized outcome through `publishToolOutcome`.

### 1. Durable progress must be checkpoint-gated — `runtime/drive/tools.ts`

`performToolInvocation`'s update callback persisted progress whenever the
options were *not* explicitly `checkpoint: false`:

```ts
publishUpdate(partial);                                  // observers: every admitted update
if (options?.checkpoint !== false) progress.write(partial); // durable: also every live update
```

`AgentHarnessToolUpdateOptions.checkpoint` is documented as
"Request replacement of this invocation's durable recovery checkpoint", i.e. it
is opt-in. Every admitted live update must still reach observers, but only an
explicit `checkpoint: true` may overwrite the durable recovery snapshot.

```ts
publishUpdate(partial);
if (options?.checkpoint === true) progress.write(partial);
```

The ordering guarantees around the callback were already correct and are now
preserved: seal → drain → publish.

### 2. Tool exceptions stay errors — `execution/tools.ts`

`executeToolCall` converts an expected tool throw into a synthetic error result
so the call can still be recorded, but it returned `isError: false`:

```ts
} catch (error) {
    return {
        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
        isError: false,   // wrong: finalizeToolCall propagates this into the message
    };
}
```

`finalizeToolCall` derives `isError` from that field (`patch?.isError ??
executed.isError`) and `createToolResultMessage` copies it into the durable
`ToolResultMessage`, so a throw was indistinguishable from success in the final
message and in the `tool_end` event. Fixed by returning `isError: true`.

### 3. `signalAbort` must deliver cancellation — `execution/effect-gate.ts`

The owner-facing control was a no-op:

```ts
signalAbort() {
    if (state.status !== "aborting" || controller.signal.aborted) return;
    // Regression: abort signal is never delivered.
},
```

`beginAbort` moves the gate to `aborting` (which already refuses *new* effect
admission with `AbortRequested`) and defers signalling until the cancellation is
durable; `reconcileOperation` and `Lane.requestOperationAbort` call
`beginAbort` → `signalAbort` once that cancellation commits. Without the
abort, admitted work kept running with a live `drive.gate.signal`, so
`waitUntil`-style waits and abort-aware tools never observed the cancellation.
The repair aborts the controller with the internal control-flow error so the
existing `AbortRequested` handling (including `await error.cancellation`) keeps
working:

```ts
signalAbort() {
    if (state.status !== "aborting" || controller.signal.aborted) return;
    controller.abort(new AbortRequested(state.cancellation));
},
```

Public APIs (`Gate`, `GateControl`, `createGate`, `executeToolCall`,
`runTools`, the recovery entry signature) are unchanged.

## Regression evidence

`.prale-eval/regression.mjs` loads the real production modules through the
read-only `.prale-eval/subject.mjs` helper (only checkpoint storage, progress
transport, hook delivery and outcome publication are faked) and exercises five
cross-module scenarios:

1. live → live → checkpoint → throw: observers see all three updates, exactly
   one durable write (the checkpoint), the published message is an error, and
   `drain-complete` precedes `publish`;
2. live-only update with a drain held open on a promise: nothing is persisted
   and publication only happens after the drain finishes;
3. `beginAbort` + `signalAbort` while the tool is admitted: the captured
   `AbortSignal` aborts and its listener fires, and the gate refuses any further
   admission with the same cancellation promise;
4. `beginAbort` before admission: the effect is never invoked and the
   interrupted, error-flagged outcome is published after the drain;
5. cancelled recovery: the tool does not run, the durable checkpoint evidence
   and interruption marker are kept, and the result is an error.

Verified locally: the script exits 0 on the repaired tree and fails with a
`node:assert/strict` `AssertionError` for each faulty file restored in
isolation (effect gate → "signalAbort must abort the admitted tool's signal";
executor → "a failed tool must publish an error result"; drive tools → "only
updates marked checkpoint: true may be persisted").

Command: `node --experimental-vm-modules .prale-eval/regression.mjs` (Node 24,
no dependencies, no network, no timers or randomness; ordering is driven purely
by promises).
