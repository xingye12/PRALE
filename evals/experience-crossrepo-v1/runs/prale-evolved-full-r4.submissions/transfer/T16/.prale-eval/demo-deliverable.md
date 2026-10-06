# Executable demo — local RPC/command adapter (pi, task T16)

## What it is

`\.prale-eval/command-adapter-demo.mjs` is a tiny, dependency-free (Node builtins
only) local RPC/command adapter that demonstrates two properties requested by
T16:

1. **Invalid input is rejected before the fake effect.** Every request is
   validated in `dispatch()` before the command handler's effect runs, so a
   rejected request never mutates the effect log.
2. **One stable error shape.** Every failure path returns the same envelope
   shape, and every `error` object has exactly `{ code, message }`.

Run it with:

```
node .prale-eval/command-adapter-demo.mjs
```

It is self-verifying (`node:assert/strict`), prints a JSON summary of the cases,
and exits non-zero if any invariant is violated. No package install or test
runner is required.

## Contract

Request envelope:

```ts
type Request = { id: string; command: string; params?: object };
```

Normalized response envelope (always the same keys):

```ts
type Response =
  | { ok: true;  id: string; result: unknown; error: null }
  | { ok: false; id: string | null; result: null; error: { code: ErrorCode; message: string } };

type ErrorCode = "INVALID_REQUEST" | "UNKNOWN_COMMAND" | "INVALID_PARAMS";
```

The error object is constructed in exactly one place (`fail()`), so all rejected
requests share the identical shape. Success is built only by `ok()`.

## Validation order (the guarantee)

`createCommandAdapter({ handlers, onEffect }).dispatch(request)`:

1. Envelope validation — `request` is a plain object; `id` is a non-empty
   string; `command` is a non-empty string. Failures return
   `INVALID_REQUEST` with `id: null` when the id itself is unusable.
2. Command resolution — unknown `command` returns `UNKNOWN_COMMAND`.
3. Params validation — `handler.validate(params)` runs before any effect;
   failure returns `INVALID_PARAMS`.
4. Fake effect — only reached after 1–3 pass. The effect (`onEffect`) is invoked
   exactly once and only once per accepted request.

## Third-party contract check

For every rejection above, `adapter.effectLog.length` is asserted to be
unchanged, i.e. the fake effect did not run. The demo also asserts that every
failure response has the key set `["error", "id", "ok", "result"]` and that
every `error` has the key set `["code", "message"]`.

## Normalized operation result (from the demo run)

```
validation: PASS - invalid input rejected before fake effect, one stable error shape
effectsApplied: 2                 (two accepted requests)
effectsAppliedAfterRejections: 0  (four rejected requests, no effect)
rejections: INVALID_PARAMS, UNKNOWN_COMMAND, INVALID_REQUEST (x2)
```

## Relation to the cited repository evidence

`packages/agent/src/proxy.ts` is the in-repo precedent for this adapter shape:
`streamProxy` sends one request (POST to `${proxyUrl}/api/stream`) and funnels
every failure — non-OK response, aborted signal, mid-stream disconnect, thrown
error — through a single terminal `{ type: "error", reason, error }` event
(`ProxyAssistantMessageEvent`), so consumers handle exactly one error shape
rather than ad-hoc exceptions. The demo generalizes that pattern to a local
command dispatch: validate first, one error shape, no effect on rejection.

## Files

| Path | Role |
| --- | --- |
| `.prale-eval/command-adapter-demo.mjs` | Executable, self-verifying demo |
| `.prale-eval/demo-deliverable.md` | This description |
| `.prale-eval/result.json` | Structured result with evidence and validation |
