# T19 demo deliverable - tiny local RPC/command adapter with reject-before-effect and one error shape

Repository: `pi` (task mode: `demo`).

## What was built

A dependency-free ESM demo of a local RPC/command adapter, plus a focused test file:

| File | Purpose |
| --- | --- |
| `packages/agent/demo/rpc-adapter-demo.mjs` | Adapter, validation, fake effect, scripted self-checking demo, and a small CLI |
| `packages/agent/demo/rpc-adapter-demo.test.mjs` | `node:test` validation of the contract (6 tests) |

No package manifest, lockfile, tsconfig, git config, or task metadata was touched; the demo lives outside
the `packages/agent/tsconfig.build.json` `src/**/*.ts` include, so the package build is unaffected.

## Executable demo

```bash
# scripted, self-checking demo: prints one normalized result per case + a summary line
node packages/agent/demo/rpc-adapter-demo.mjs

# dispatch a single request from the command line (JSON in, normalized result out)
node packages/agent/demo/rpc-adapter-demo.mjs '{"command":"echo","params":{"text":"hello"}}'
node packages/agent/demo/rpc-adapter-demo.mjs '{"command":"echo","params":{}}'

# focused validation
node --test packages/agent/demo/rpc-adapter-demo.test.mjs
```

Observed results: scripted demo prints `{"summary":"pass","cases":10,"failures":0,"effectsApplied":2}` and exits 0;
the test file reports `pass 6`, `fail 0`.

## Contract

Request envelope (JSON-ish, one adapter call):

```ts
type Request = { command: string; params?: Record<string, unknown> };
```

`dispatch(request)` always returns exactly one of two normalized results and **never throws**:

```ts
type OperationResult =
  | { ok: true;  result: unknown }
  | { ok: false; error: { code: string; message: string; details: object } };
```

### 1. Invalid input is rejected before the fake effect

`dispatch` runs a strict, ordered validation phase and returns early at the first failure:

1. request must be a plain object;
2. `request.command` must be a non-empty string;
3. the command must exist in the command table;
4. `request.params` must be a plain object when present;
5. params must satisfy the command schema - required keys present, correct types, and no unexpected keys.

The fake effect (`createFakeEffect().apply`, which records every call) is reachable only after all five checks
pass (`packages/agent/demo/rpc-adapter-demo.mjs`, effect phase). Consequently every invalid request leaves
`effect.count() === 0`; the test suite asserts this for 18 invalid requests individually and again in an
aggregate shape test.

### 2. One stable error shape

All failures - malformed request, unknown command, invalid params, *and* a command body that throws at effect
time - are constructed by the single `reject(code, message, details)` helper, producing

```json
{ "ok": false, "error": { "code": "invalid_params", "message": "params.text must be a non-empty string",
                          "details": { "command": "echo", "problems": ["params.text must be a non-empty string"] } } }
```

Codes: `invalid_request`, `unknown_command`, `invalid_params`, `effect_failed`. The shape is executable:
`isErrorEnvelope(value)` returns true only for an object with exactly the keys `[ok, error]` whose `error` has
exactly `[code, message, details]` and the right value types; `isSuccessEnvelope(value)` does the same for
`{ ok: true, result }`. The test suite asserts both the exact key sets and the shape predicate for every
rejection, so no code path can drift into a second error format.

## Transfer from `packages/agent/src/proxy.ts`

The demo deliberately copies the failure-handling structure of the repo's proxy stream function:

- `streamProxy` (`packages/agent/src/proxy.ts`, lines 120-265) throws for a non-ok response at lines 174-185,
  *before* `response.body` is consumed, and later folds both the dropped-stream case (232-243) and any thrown
  exception / abort (246-256) into the identical `{ type: "error", reason, error }` event - the one stable
  error shape declared by `ProxyAssistantMessageEvent` (lines 36-61). The demo's single rejection envelope and
  its `EFFECT_FAILED` mapping of thrown command bodies mirror this.
- `processProxyEvent` (lines 270-406) validates each event against the current partial state and throws
  *before* mutating it (e.g. `text_delta` throws at line 293 rather than writing into a non-text slot), and
  unknown events return `undefined` instead of corrupting state (lines 400-404). The demo's validate-then-act
  ordering is the same idea applied to command dispatch.
- Where the proxy uses a terminal stream event, `dispatch` returns a value: a local request/response RPC
  adapter has no stream, so the normalized `OperationResult` is the single observation point for callers.

## Validation notes and limitation

- `node --test packages/agent/demo/rpc-adapter-demo.test.mjs` -> passed (6/6).
- `node packages/agent/demo/rpc-adapter-demo.mjs` -> passed (10/10 cases, exit 0).
- LIMITATION: the workspace has no `node_modules` and dependencies must not be installed, so the repository's
  own vitest suite covering the cited source file (`packages/agent/test/proxy.test.ts`, normally
  `npm run test -w @earendil-works/pi-agent-core`) could not be run. The demo and its test are dependency-free
  ESM precisely so the focused validation still executes with plain Node (v24.14.0).
