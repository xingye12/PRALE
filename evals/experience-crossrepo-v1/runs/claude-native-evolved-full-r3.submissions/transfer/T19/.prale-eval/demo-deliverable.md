# T19 - local RPC/command adapter demo (repo `pi`)

## What this is

A tiny, self-contained local command adapter that transfers two behaviors from
`packages/agent/src/proxy.ts` into a synchronous request/response boundary:

1. **Invalid input is rejected before the fake effect.** Validation is a pure
   pass over the raw input. It never reads or writes `AdapterState`, so a
   rejected command cannot have run the effect.
2. **One stable error shape.** Every failure path - validation, runtime miss,
   or an unexpected internal throw - normalizes into the same
   `{ ok: false, error: { code, message, command } }` object. No exception
   escapes the boundary.

## Executable demo

File: `.prale-eval/demo/rpc-command-adapter.ts` (runnable with Node's built-in
TypeScript type stripping, no dependencies required).

```
node .prale-eval/demo/rpc-command-adapter.ts
```

Exit code `0` when every check passes, `1` otherwise. It executes eight checks
against an in-memory adapter and prints one `PASS`/`FAIL` line per check:

- a valid `set` reaches the effect and mutates state;
- a `set` with a non-numeric `value` is rejected as `bad_request`, the effect
  list is unchanged, and the previously stored value is untouched;
- an unknown command type (`text_delta`) is rejected as `unsupported_command`
  with no effect;
- a non-object input (`42`) is rejected as `bad_request`, `command: "unknown"`,
  with no effect;
- a `get` for a missing key returns `not_found` in the same shape;
- all four rejections have identical top-level and `error` keys;
- a forced internal failure is normalized to `internal`, not thrown;
- no throw escapes the boundary call.

## Contract

```ts
type ErrorCode = "bad_request" | "unsupported_command" | "not_found" | "internal";

interface AdapterError {
  code: ErrorCode;      // stable, closed set
  message: string;      // stable text, no stack trace
  command: string;      // offending command type, or "unknown"
}

type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: AdapterError };
```

`handleCommand(state, raw)` is the single boundary. Its result is a discriminated
union; the failure variant always has exactly the keys `ok` and `error`, and
`error` always has exactly `code`, `message`, and `command`. Invalid input
(`bad_request`, `unsupported_command`) is caught in `validate` before
`applyCommand` - the only function allowed to touch `AdapterState.effects` - is
called.

## Normalized operation result

Input `{ type: "set", key: "a", value: "1" }` (a number as a string):

```json
{ "ok": false, "error": { "code": "bad_request", "message": "set requires a finite numeric 'value'", "command": "set" } }
```

`state.effects.length` is unchanged by this call, proving the effect was never
reached.

## Mapping to `packages/agent/src/proxy.ts`

| Demo element | proxy.ts origin |
| --- | --- |
| `validate` rejecting before `applyCommand` | `processProxyEvent` checks each event against the partial message and throws (`Received text_delta for non-text content`) before mutating it. |
| `toAdapterError` / the single `catch` in `handleCommand` | `streamProxy` wraps the whole request in one `try/catch`; every failure becomes `{ type: "error", reason, error }` with `stopReason`/`errorMessage` set. |
| `AdapterError` closed `code` set | The proxy event union fixes a single `error` variant shape (`reason`, `errorMessage`, `usage`, `providerThinkingLevel`). |
| Normalizing an unknown command type | `streamProxy` normalizes a non-OK HTTP response into one `Proxy error: ...` message instead of surfacing the raw response. |

## Verification

```
node .prale-eval/demo/rpc-command-adapter.ts
```

Result: `ALL CHECKS PASSED`, exit code `0` (Node v24.14.0, no install step).
