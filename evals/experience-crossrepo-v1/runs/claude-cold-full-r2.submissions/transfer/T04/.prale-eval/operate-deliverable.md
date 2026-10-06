# Operate deliverable — normalize a child-process failure into a structured server result

Task: **T04** · Repository: **wattclaw** · Mode: **operate**

## What was operated

A fake backend command / child-process failure is now normalized into a stable,
non-throwing server result **without losing diagnostics**. The change is additive
and backward compatible.

### Contract (the normalized operation result)

Every child-process outcome is represented by one JSON-serializable object:

```jsonc
// success
{ "ok": true,  "error": null, "command": "...", "exitCode": 0,
  "signal": null, "stdout": "...", "stderr": "",  "timedOut": false, "spawnError": null }

// failure
{ "ok": false, "error": "boom: db locked", "command": "...",
  "exitCode": 7, "signal": null, "stdout": "partial-out",
  "stderr": "boom: db locked", "timedOut": false, "spawnError": null }
```

- `ok` is the discriminant callers branch on.
- `error` is the human-readable message.
- `exitCode`, `signal`, `stdout`, `stderr`, `timedOut`, `spawnError` are the raw
  **diagnostics**, preserved verbatim.

This mirrors the repository's existing `{ ok: false, error }` / `{ ok: true, ... }`
convention in `server/core/gateway-client.js`, so exec failures and gateway
failures are handled identically by callers.

## Where it lives

`server/core/system.js` (the only source file changed):

| Symbol | Lines | Role |
| --- | --- | --- |
| `localExec` | 111–156 | Spawns the command. All rejection paths (non-zero close, timeout, spawn error) now attach `err.diagnostics = { command, exitCode, signal, stdout, stderr, timedOut, spawnError }`. Still rejects with an `Error`, so existing callers (`gatewayExec`, `server/handlers/*`) are unchanged. |
| `normalizeExecFailure` | 164–178 | Pure mapper: any failure (an `Error` with `.diagnostics`, or a raw value + explicit `meta`) → the `{ ok:false, ...diagnostics }` shape. Never throws. |
| `localExecResult` | 185–192 | Non-throwing wrapper over `localExec`; returns the structured result instead of rejecting. |

No call sites, package locks, git configuration, or task metadata were modified.

## Executable demo

`.prale-eval/demo-normalize-exec.mjs` exercises the **real** helpers above with
fake failing commands. It imports `server/core/system.js` directly.

Because this evaluation workspace has no `node_modules`, the module's only
third-party import (`check-disk-space`) is supplied by a local resolution hook:

- `.prale-eval/harness/loader.mjs` — maps the `check-disk-space` bare specifier to a stub.
- `.prale-eval/harness/check-disk-space-stub.mjs` — returns `{ size: 0, free: 0 }`.
- `.prale-eval/harness/register.mjs` — registers the hook.

The stub is never reached on the exec paths under test.

### Run

```bash
node --import ./.prale-eval/harness/register.mjs .prale-eval/demo-normalize-exec.mjs
```

### Scenarios exercised

1. **Non-zero exit (7)** with stdout *and* stderr → `ok:false`, `exitCode:7`,
   both streams preserved, `error` carries the stderr text.
2. **Command not found** → `ok:false`, `exitCode:127`, stderr preserved.
   (Assertion is wording-agnostic: this sandbox's shell says "Permission denied",
   others say "not found".)
3. **Timeout** (500 ms limit on a 5 s sleeper) → `ok:false`, `timedOut:true`,
   `signal:"SIGTERM"`, error mentions the timeout.
4. **Success** → same shape, `ok:true`, `exitCode:0`, stdout captured.
5. **`normalizeExecFailure` on a raw `Error` + explicit meta** → `spawnError`
   surfaced.
6. **Back-compat**: `localExec` still throws for existing callers, but the thrown
   error now carries `err.diagnostics`.

### Result

```
EXIT=0
=== summary ===
{ "cases": 5, "failures": 0 }   // 86 assertions
```

Raw captured output: `.prale-eval/demo-output.txt`.
