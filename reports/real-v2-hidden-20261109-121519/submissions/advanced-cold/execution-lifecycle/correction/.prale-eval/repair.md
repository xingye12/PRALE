# Repair: safe recovery without corrupting patched outcomes

Three production defects in the durable tool-execution lifecycle combined to break
recovery after an interrupted pass. They are coupled: recovery decides whether an
effect may be replayed, the effect gate decides whether that replay and the
after-tool hook are admitted at all, and the executor/finalizer decides what the
patched result says once the effect settles.

## 1. Safe/safe replay was disabled — `packages/agent/src/harness/runtime/drive/tools.ts`

`recoverToolInvocation` chose between two recovery paths:

- *safe replay*: clear the durable replay checkpoint, re-run the tool with the
  persisted arguments (same invocation id, same memos), and publish the fresh
  outcome;
- *interrupt*: publish an error tool result built from the last durable progress
  checkpoint with an "external outcome is unknown" marker.

The replay branch was short-circuited with `if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe")`,
so every recovered call fell through to the interrupt path, even for a
non-cancelled call whose persisted record and tool declaration were both `safe`.
The condition now depends only on the real policy inputs:

```ts
if (!cancelled && call.replay === "safe" && tool?.replay === "safe") {
```

Cancelled recovery and `never`/undeclared tools still settle on the checkpoint, so
an effect is only re-entered when both the durable record and the tool declaration
allow it. The signature, return type and `ToolCallTask` contract are unchanged.

## 2. An explicit `isError: false` after-tool patch was ignored — `packages/agent/src/harness/execution/tools.ts`

`finalizeToolCall` applied the after-tool patch field by field with `=== undefined`
guards so unspecified fields and `usage` survive, but merged the error flag with a
truthiness test:

```ts
isError: patch?.isError || executed.isError
```

`false || true` kept a raw tool failure marked as an error, so a hook that
deliberately salvages a failed tool call (for example after a retry outside the
tool) could never clear `isError`. The merge now distinguishes "unspecified" from
"explicitly false", matching the field-by-field handling of `content`,
`details`, `usage` and `terminate`:

```ts
isError: patch?.isError ?? executed.isError
```

Explicit `false`/empty patch values (`isError: false`, `content: []`,
`terminate: false`) are applied, while fields and `usage` the hook leaves
unspecified are preserved from the executed result and reach the staged
`toolResult` message unchanged.

## 3. A terminal closure lost to a pending cancellation — `packages/agent/src/harness/execution/effect-gate.ts`

`createGate().control.close(error)` refused to act unless the gate was still
`open`:

```ts
if (state.status !== "open") return;
```

While a cancellation is pending the gate is `aborting`, so a terminal error that
arrived during cancellation (`Drive.closeGate` → `control.close`) was dropped.
The gate then kept reporting `AbortRequested` for every later admission, letting a
cancellation that was still in flight override the terminal failure, and the
abort signal never received the terminal reason. `close` is now idempotent only
against an already-closed gate and overwrites the in-flight abort state:

```ts
if (state.status === "closed") return;
state = { status: "closed", error };
if (!controller.signal.aborted) controller.abort(error);
```

`beginAbort` still only transitions out of `open`, so a closure can never be
reopened, and `signalAbort` still only signals a genuinely aborting gate. Future
admissions throw the terminal error, and everything downstream (recovery, the
after-tool hook admission in `performToolInvocation`, finalization) surfaces that
error instead of a patched or interrupted outcome.

## Cross-module behavior verified by `.prale-eval/regression.mjs`

The script drives the real `runtime/drive/tools.ts` recovery path, the real
`execution/tools.ts` executor/finalizer and the real `execution/effect-gate.ts`
through the read-only `subject.mjs` graph (only checkpoint storage, progress
transport, hook delivery and `withAbortSignal` are faked). It asserts:

1. non-cancelled `safe`/`safe` recovery clears the checkpoint, re-invokes the tool
   with the persisted arguments, publishes exactly one non-error outcome that keeps
   `details`/`usage`, runs against the gate signal, and never reads the checkpoint;
2. cancelled recovery and `never`/undeclared tools still publish the interruption
   result from the durable checkpoint without invoking the tool;
3. an after-tool patch may clear `isError` and replace content with an explicit
   empty array, preserving unspecified fields;
4. explicit `false`/empty patch values are applied while unspecified `content`,
   `details` and `usage` are preserved through to the `toolResult` message;
5. closing an aborting gate with a terminal error makes that error the abort
   reason and the authoritative refusal for all later admissions, even after the
   pending cancellation settles or a new abort is requested;
6. across the lifecycle, closing the gate while aborting makes the remaining
   admission of the invocation reject with the terminal error rather than
   completing with a patched outcome.

Each assertion was also confirmed to fail (with an assertion error, not a crash or
import failure) when exactly one of the three repaired files was restored to its
faulty baseline: `runtime/drive/tools.ts` fails check 1, `execution/tools.ts` fails
check 3, and `execution/effect-gate.ts` fails check 5. No dependencies, network,
real time or randomness are used.
