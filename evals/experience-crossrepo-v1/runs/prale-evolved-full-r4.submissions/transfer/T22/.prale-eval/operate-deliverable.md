# T22 — Normalize a fake backend command/child-process failure into a structured server result

Repository: `wattclaw` · Mode: `operate`

## Problem

`server/core/system.js#localExec` (line 111) spawns the local "backend" command with
`spawn(cmd, { stdio: 'pipe', shell: true })`. On failure it **rejects** with a bare
`Error` whose message is a single collapsed string:

```js
reject(new Error((stderr || stdout || `Command failed with exit code ${code}`).trim()))
```

`gatewayExec` (line 150) is a one-line pass-through to `localExec`, and every handler
that shells out (`server/handlers/files.js`, `skill-store.js`, `workspace.js`,
`backup.js`) therefore only ever sees `err.message`. Exit code, signal, and the partial
stdout/stderr captured while the fake backend was running are dropped, and the server's
generic error path (`server/index.js` error middleware → `{ ok:false, error:{ message } }`)
can no longer distinguish "backend rejected the input" (exit 3) from "backend binary is
missing" (ENOENT) from "backend hung" (timeout).

The repository already has a normalization precedent for *remote* backends:
`server/core/gateway-client.js#gatewayAdminRpcForTarget` (line 60) never throws on
transport failure — it resolves `{ ok:false, error }` and keeps a WS fallback for 404s.
T22 adds the equivalent for *local* child processes.

## Deliverable

New module `server/core/process-result.js` (only Node built-ins, no new dependencies):

| Export | Contract |
| --- | --- |
| `PROCESS_FAILURE_KIND` | `spawn_error` \| `nonzero_exit` \| `timeout` |
| `PROCESS_FAILURE_CODE` | `PROCESS_SPAWN_ERROR` \| `PROCESS_NONZERO_EXIT` \| `PROCESS_TIMEOUT` |
| `buildProcessDiagnostics(error, context)` | Lossless diagnostic bundle, `context` wins over fields carried on the error |
| `normalizeProcessFailure(error, context)` | Total (never throws) → `{ ok:false, error:{ code, kind, message, diagnostics } }` |
| `runCommandResult(cmd, options)` | Same spawn semantics as `localExec`, but always **resolves** |

### Normalized operation result

Success:

```json
{ "ok": true,
  "payload": { "command": "...", "exitCode": 0, "signal": null,
               "stdout": "...", "stderr": "...", "durationMs": 23 } }
```

Failure — diagnostics are a first-class field, nothing is folded into `message`:

```json
{ "ok": false,
  "error": {
    "code": "PROCESS_NONZERO_EXIT",
    "kind": "nonzero_exit",
    "message": "fake-backend: upstream 503",
    "diagnostics": {
      "command": "node -e \"...\"",
      "cwd": null,
      "exitCode": 3,
      "signal": null,
      "stdout": "partial payload",
      "stderr": "fake-backend: upstream 503",
      "timedOut": false,
      "timeoutMs": null,
      "durationMs": 25,
      "spawnCode": null,
      "errno": null,
      "syscall": null
    }
  } }
```

`runCommandResult` mirrors `localExec`'s timeout policy (SIGTERM, then SIGKILL after
5 s) but sets `diagnostics.timedOut = true` and keeps the partial output. The
`options.spawnImpl` seam lets callers/tests inject a fake child process (e.g. one that
emits an `error` event with `code: 'ENOENT'`) without touching the real shell — this is
how the "fake backend" scenarios are produced deterministically.

## Executable demo

```
node server/core/process-result.demo.mjs
```

The demo drives six scenarios and asserts the contract, exiting non-zero on any failure:

1. Fake backend exits `3` after writing to both streams → `exitCode: 3`, `stdout`,
   `stderr` all preserved (and a message-only envelope is shown to lose them).
2. Fake backend cannot be spawned (injected ENOENT `error` event) →
   `kind: spawn_error`, `spawnCode: 'ENOENT'`, `errno: -2`, `command` kept.
3. Fake backend hangs → `kind: timeout`, `timedOut: true`, `timeoutMs: 500`,
   partial stdout kept.
4. Success path → `{ ok:true, payload:{ exitCode:0, stdout:'ok' } }`.
5. `normalizeProcessFailure(new Error('boom'))` is total → never throws.
6. The cited contract symbols (`localExec`, `gatewayExec`, `gatewayAdminRpcForTarget`,
   `_sanitizeLogParams`) still exist in the source files.

Observed run: all checks passed, exit code `0`.

## Scope / minimality

Only two files are added: the module and its demo. No existing file, task metadata,
lockfile, or git configuration is modified, and no dependency is installed.
