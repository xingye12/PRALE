# Repair: safe recovery without corrupting patched outcomes

Task: `advanced/execution-lifecycle/correction` (repository `earendil-works/pi`, mode `repair`).

The incident is split across three production modules of the durable agent harness
(`packages/agent/src/harness`). Each repair is a one-line semantic correction; no API,
type surface, event shape or unrelated behaviour changed.

## 1. `execution/effect-gate.ts` — a terminal closure must beat a pending cancellation

`createGate()` keeps one of three states: `open`, `aborting`, `closed`.
`close(error)` used to bail out unless the gate was still `open`, so a gate that had
already entered `aborting` (cancellation requested, `signalAbort()` not yet applied)
silently ignored the terminal error. Every later `admit()` then re-threw
`AbortRequested` carrying the *pending cancellation*, so the owner's terminal error never
became authoritative and a cancellation that resolved later could look like the reason for
refusal.

```diff
- if (state.status !== "open") return;
+ if (state.status === "closed") return;
```

Consequences, all observable through the gate's public surface:

* `aborting` + `close(error)` now moves the gate to `closed`; `admit()` throws `error`
  (the terminal error), never `AbortRequested`.
* The signal is aborted with that terminal error when it was not aborted yet, so
  `gate.signal.reason` is the terminal error rather than a cancellation.
* `signalAbort()` after the closure is a no-op (it only acts on `aborting`), so a late
  cancellation commit can no longer override the closure.
* Re-closing keeps the first terminal error, preserving idempotent owner semantics.

This is a producer/consumer boundary: `HookRegistry.runWithGate`/`runToolWithGate`
(hooks.ts) and `executeToolCall` (execution/tools.ts) are the consumers of `admit()` and
inherit the corrected behaviour without their own changes.

## 2. `execution/tools.ts` — explicit `isError: false` from an after-tool hook survives

`finalizeToolCall` merges the `after_tool` aggregate patch field by field. `content`,
`details`, `usage` and `terminate` already used "apply unless `undefined`" (so explicit
`false`/empty values are applied, and unset fields — including `usage` — are preserved
from the executed result). `isError` alone used `||`:

```diff
- isError: patch?.isError || executed.isError,
+ isError: patch?.isError ?? executed.isError,
```

With `||`, an explicit `patch.isError === false` (the documented way for an after-tool
hook to recover a failed tool) was swallowed whenever the execution had failed, so a
hook-cleared result was still staged and reported as an error. `??` keeps the requested
"explicit value wins, otherwise inherit the execution outcome" semantics, and an explicit
`true` still overrides a successful execution. Field-by-field merging of `content`,
`details`, `usage`, `terminate` and the `...executed.result` spread (unmodelled fields)
is untouched.

## 3. `runtime/drive/tools.ts` — non-cancelled safe/safe replay is allowed

Recovery of an `effect_pending` tool call decided between "replay it" and "synthesize an
interrupted result". The replay branch was hard-disabled by a leftover `false &&`, so
every safe/safe call was treated as interrupted even though the durable intent recorded
`replay: "safe"` and the registered tool declares `replay: "safe"`:

```diff
- if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe") {
+ if (!cancelled && call.replay === "safe" && tool?.replay === "safe") {
```

The guard now expresses exactly the policy: replay requires a non-cancelled recovery, a
`safe` durable checkpoint and a `safe` tool declaration. Reuse therefore goes through the
existing path — `clearReplayCheckpoint` publishes the persisted arguments commit (deleting
the progress checkpoint) *before* the effect, the tool is re-invoked with the persisted
arguments and its durable replay memos, and the outcome is published with
`recovery: true`. Cancelled recoveries, `replay: "never"` checkpoints and tools without a
`safe` declaration still produce the interruption result, keep the durable checkpoint
content in the transcript and never cross the external effect boundary.

## Cross-module verification (`.prale-eval/regression.mjs`)

The script links the four real production modules in one `createGraph` graph

```
execution/effect-gate.ts  execution/tools.ts  hooks.ts  runtime/drive/tools.ts
```

and supplies its own boundary fakes for the rest of the harness (lane command bus and
settled-operation bus, session value store, progress channel, session invariant error,
tool placement, telemetry span, abort-signal context). Private procedures that live
outside the public API (`recoverToolInvocation`, `performToolInvocation`) are exposed to
the test through the documented `trailers` hook of `subject.mjs`. There is no real clock,
randomness, network or filesystem input; ordering is driven by promises and by recording
the commit/event timeline of the fake lane.

Seven checks are asserted with uncaught `node:assert/strict` assertions:

1. aborting gate closed with a terminal error → terminal error authoritative, signal
   reason is the terminal error, late `signalAbort()` cannot override it, re-close keeps
   the first error;
2. `HookRegistry.runToolWithGate` on such a gate refuses admission with the terminal
   error and never runs the handler (hooks ↔ gate boundary);
3. non-cancelled safe/safe replay re-invokes the tool exactly once with the persisted
   arguments and persisted memo, clears the checkpoint before `tool_start`, streams the
   replayed `tool_update`, stages a non-error result and deletes the memos (drive ↔
   execution ↔ hooks boundary);
4. cancelled, unsafe-call, unsafe-tool and default-tool recoveries never execute the
   effect and stage the interrupted result with the preserved checkpoint details;
5. an after-tool hook explicitly clearing `isError: false` on a failed tool is honoured
   end-to-end in the staged result;
6. explicit empty `content: []`, explicit `terminate: false` and explicit `isError: true`
   patches are applied while unpatched `details`/`usage` are preserved by identity;
7. with no hook, a failing tool still stages `isError: true` with the tool failure text.

Mutation check (performed manually in the workspace, then reverted): restoring each of
the three files alone to its faulty baseline makes the script fail with a real assertion
(gate checks 1–2, finalize check 5, replay check 3) — no import error, crash or timeout.

Limitation: the repository's own vitest suites and type checks were not run because
`node_modules` is not installed in this workspace and dependency installation is out of
scope. The vm-module regression above is the focused validation and uses only Node 24
built-ins.
