# Repair: allow safe recovery without corrupting patched outcomes

Task ID: `advanced/execution-lifecycle/correction` — repository `earendil-works/pi`.

## Symptom chain

A tool call that was durably recorded as `effect_pending` (crash/restart recovery) was
never actually replayed, an after-tool hook could not clear `isError`, and a drive that
was already cancelling could not be closed with the terminal error that superseded the
cancellation. The three faults live in three different modules and only become visible
together: the drive recovery procedure decides *whether* to replay, the executor/finalizer
decides *what result* a replayed effect yields, and the effect gate decides *which refusal*
an admission observes once the drive pass is terminal.

## Faults and repairs

### 1. `packages/agent/src/harness/runtime/drive/tools.ts` — dead safe/safe replay

```diff
-	if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe") {
+	if (!cancelled && tool !== undefined && call.replay === "safe" && tool.replay === "safe") {
```

`recoverToolInvocation` guards the replay branch. The leading `false &&` made the whole
condition statically dead, so *every* recovered `effect_pending` call fell through to
`readCheckpoint` + `interruptedOutcome`, even when the durable intent said `replay: "safe"`
and the resolved tool also declared `replay: "safe"` and no cancellation was pending.
Policy: a non-cancelled safe/safe pair is allowed to replay. The predicate also now states
the tool-presence requirement explicitly (`tool !== undefined`) so the narrowing that the
branch body relies on (`{ toolCall, tool, args }`) is not left to optional-chain analysis.

Preserved: cancelled recovery still settles from the checkpoint, unsafe intents
(`replay: "never"`), unsafe tool declarations, and tools that are no longer resolvable still
produce the interruption result. The replay path still clears the checkpoint and its
persisted arguments before crossing the external effect boundary
(`clearReplayCheckpoint` → `performToolInvocation` → `publishToolOutcome`), and it runs with
`recovery: true`.

### 2. `packages/agent/src/harness/execution/tools.ts` — `isError` could only be raised

```diff
-		isError: patch?.isError || executed.isError,
+		isError: patch?.isError ?? executed.isError,
```

`finalizeToolCall` is the only place where the aggregated after-tool patch becomes the
durable tool-result message. `||` folds an explicit `false` back to the executed flag, so a
hook that deliberately downgrades a recovered failure (for example "the effect failed but
the durable checkpoint proves it completed") could never clear the error bit. `??` honours
an explicit boolean and only falls back when the hook left the field unspecified.

The field-by-field result merge above it is intentionally untouched: `...executed.result`
spreads every unspecified field, `content`/`details`/`usage`/`terminate` are replaced only
when the patch supplies a value (`=== undefined` tests, not truthiness), so explicit
`content: []`, `terminate: false` and `isError: false` are applied while unmentioned fields
and `usage` survive. `createToolResultMessage` then forwards `details`/`usage` only when
present.

### 3. `packages/agent/src/harness/execution/effect-gate.ts` — terminal close lost to a pending cancellation

```diff
 		close(error) {
-			if (state.status !== "open") return;
+			if (state.status === "closed") return;
 			state = { status: "closed", error };
 			if (!controller.signal.aborted) controller.abort(error);
 		},
```

`close` used to be ignored unless the gate was still `open`. Once `beginAbort` had moved the
gate to `aborting` — which is exactly the window in which `Drive.closeGate`/`Lane.seal`
runs — a terminal `Error` was silently dropped: `gate.admit` kept throwing `AbortRequested`
for that stale cancellation promise, so procedures (hook admission, effect admission)
reported cancellation instead of the terminal failure that ended the drive pass. Now only a
genuinely closed gate short-circuits, `aborting → closed` promotes the terminal error, and
`check()` therefore refuses every later admission with that error. Because the signal is
aborted with the terminal error too, admitted work observes the same authoritative reason.
`beginAbort` still refuses to downgrade a closed gate and `signalAbort` still only fires the
`AbortRequested` abort while the gate is aborting, so a late cancellation cannot override
the closure.

## Cross-module behavior asserted by `.prale-eval/regression.mjs`

The script loads the real modules through `.prale-eval/subject.mjs` (real
`recoverToolInvocation`, real `performToolInvocation` → `executeToolCall` →
`finalizeToolCall` → `createToolResultMessage`, real `createGate`, real placement/tool-call
resolution). Only checkpoint storage, progress transport, hook delivery and provider/argument
validation boundaries are faked. Verified behaviors:

1. `persisted: "safe"` + `declared: "safe"` and not cancelled → checkpoint clear happens
   before a real effect invocation, the effect receives the persisted arguments and the
   stable invocation id, and the published tool-result message carries the effect result
   (`isError: false`, no interruption marker, `details`/`usage` intact).
2. `declared: "never"`, a missing tool declaration, and `persisted: "never"` still settle
   from the checkpoint with the interruption marker and checkpoint `details`.
3. `cancelled: true` still wins over safe replay (no `clear`, no invocation, interrupted
   result).
4. A throwing effect plus `patch: { isError: false }` yields `isError: false` while the error
   text is preserved; `patch: { isError: true }` still raises the flag.
5. `patch: { content: [], isError: false, terminate: false, details: undefined, usage: undefined }`
   applies the explicit empty/false values and preserves `details`/`usage`; no patch
   preserves the whole executed result.
6. A gate that is closed while a cancellation is pending rejects later admissions
   (including the real after-tool hook admission inside the drive pass) with the terminal
   error, and a subsequent `beginAbort`/`signalAbort` cannot override it.

Mutation check performed locally (each file restored alone to its faulty baseline, all
detected as `node:assert/strict` failures, never as crashes/import errors or timeouts):

| reverted file | first failing assertion |
| --- | --- |
| `runtime/drive/tools.ts` | `safe/safe recovery replays persisted arguments…` (no `clear`/`invoke` events) |
| `execution/tools.ts` | `an after-tool hook may explicitly clear isError…` (`isError` stayed `true`) |
| `execution/effect-gate.ts` | `a terminal close of an aborting gate…` (missing expected rejection) |

## Validation

Command: `node --experimental-vm-modules .prale-eval/regression.mjs` (workspace root, Node
24.14.0) → 8 checks pass, exit code 0. No dependencies, network, credentials or real time
were used; asynchronous ordering is driven by explicit promise boundaries and in-memory
fixtures, and no temporary files are created on disk (every input is built in memory), so
nothing needed cleanup beyond removing the local probe/backup scratch files.

Not exercised: `vitest`/`tsgo` type-checks and the package test suites, because the workspace
has no installed `node_modules` and dependencies must not be installed. TypeScript syntax is
still exercised because the regression harness strips types with
`node:module.stripTypeScriptTypes` and evaluates every touched module.
