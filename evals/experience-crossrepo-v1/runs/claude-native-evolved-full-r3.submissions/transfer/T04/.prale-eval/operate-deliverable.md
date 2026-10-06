# T04 — Normalize a fake backend command/child-process failure (wattclaw, mode `operate`)

## What was operated

A cross-repository pattern — "never let a transport/command failure escape as a thrown
`Error`; convert it into a structured `{ ok, error }` server result that keeps every
diagnostic" — was applied to WattClaw's child-process execution path.

The repo's Gateway HTTP layer already implements this contract
(`server/core/gateway-client.js` → `gatewayAdminRpcForTarget`): it returns
`{ ok: true, payload }` or `{ ok: false, error }` and never rejects. The command layer
(`server/core/system.js` → `localExec`) does **not**: it rejects with a plain `Error`
whose message is `stderr || stdout || "Command failed with exit code N"`, collapsing
distinct failure modes into one lossy string. The operation normalizes that failure into
the Gateway layer's result shape while preserving the diagnostics `localExec` drops.

## Executable demo

`scripts/normalize-command-failure.mjs` — dependency-free ESM module, runs on the repo's
Node runtime.

```bash
node scripts/normalize-command-failure.mjs
```

It exercises three fake backend/child-process failures plus one clean run through an
injectable runner seam (`runCommand(runner, command, options)`), then asserts the
normalized result. The fakes are deterministic and spawn nothing external:

| Fake runner | Simulates | Normalized `error.code` |
| --- | --- | --- |
| `fakeExitFailure` | process exits `3`, writes both stdout and stderr | `COMMAND_EXITED_NONZERO` |
| `fakeSpawnFailure` | `spawn ... ENOENT` (runner throws, like `localExec`) | `COMMAND_SPAWN_FAILED` |
| `fakeTimeoutFailure` | killed after timeout, `SIGTERM`, no exit code | `COMMAND_TIMED_OUT` |
| `fakeSuccess` | clean `exitCode 0` | — (`ok: true`) |

Observed output (13/13 assertions PASS, exit code 0):

```json
{"ok":false,"error":{"code":"COMMAND_EXITED_NONZERO","message":"fake-backend: no such workspace",
 "command":"fake-backend list-workspaces","causeCode":null,"exitCode":3,"signal":null,
 "stdout":"partial-work-completed\n","stderr":"fake-backend: no such workspace\n","timedOut":false,"durationMs":0}}
```

## Contract (normalized operation result)

`normalizeCommandFailure(failure, context)` never throws and always returns:

```ts
type CommandResult =
  | { ok: true;  stdout: string; stderr: string; exitCode: number; durationMs: number | null }
  | { ok: false; error: {
      code: 'COMMAND_EXITED_NONZERO' | 'COMMAND_SPAWN_FAILED' | 'COMMAND_TIMED_OUT';
      message: string;      // richest available human diagnostic
      command: string | null;
      causeCode: string | null;  // native OS code, e.g. 'ENOENT'
      exitCode: number | null;   // null when killed by signal / never spawned
      signal: string | null;     // e.g. 'SIGTERM'
      stdout: string;            // preserved, never dropped when stderr exists
      stderr: string;
      timedOut: boolean;
      durationMs: number | null;
    } }
```

Diagnostics preserved that the current `localExec` rejection loses:

- **`stdout`** — dropped today whenever `stderr` is non-empty (the `||` chain).
- **`exitCode`** — dropped today whenever `stderr`/`stdout` is non-empty.
- **`signal`** — never surfaced today; distinguishes SIGKILL/SIGTERM kills.
- **`timedOut`** — today only inferable by string-matching the message.
- **`causeCode`** — native `ENOENT`/`EACCES` etc. retained separately from the
  classification, so classification stays stable.
- **`command` / `durationMs`** — captured at the call boundary for correlation.

`runCommand` is defensive: a runner that throws (mirroring `localExec`'s rejection) is
still normalized into the same envelope, so wrapping `gatewayExec()` with it would let
`server/handlers/*` forward `result.error` instead of collapsing to `err.message`.

## Validation

```bash
node scripts/normalize-command-failure.mjs   # exit 0, ALL CHECKS PASSED
```

No repository test framework or linter is configured (per `CLAUDE.md`), so the focused
relevant validation is the demo's own self-check. No production files, package locks,
task metadata, or git configuration were modified; the only changes are the new demo
script and these `.prale-eval/` artifacts.
