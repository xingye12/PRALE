# T19 demo deliverable: local RPC/command adapter

## What this is

A tiny, dependency-free local RPC/command adapter that demonstrates the two
behaviors transferred from `packages/agent/src/proxy.ts`:

1. **Invalid input is rejected before the fake effect runs.**
2. **Every failure is reported through one stable error shape.**

Artifacts:

- Executable demo: `.prale-eval/rpc-adapter-demo.ts`
- This description: `.prale-eval/demo-deliverable.md`
- Machine-readable result: `.prale-eval/result.json`

## Running it

```sh
node .prale-eval/rpc-adapter-demo.ts
```

The file uses only erasable TypeScript syntax (interfaces, type aliases, type
annotations), so Node runs it directly under strip-only mode with no build step,
no `node_modules`, and no imports. Exit code is `0` when every check passes and
`1` otherwise.

## Contract

The adapter exposes one entry point, `dispatch(request: unknown): AdapterResult`.

Result type:

```ts
type AdapterResult = AdapterOk | AdapterError;

interface AdapterOk {
  type: "ok";
  requestId: string;
  value: unknown;
}

interface AdapterError {
  type: "error";
  code: "invalid_envelope" | "unknown_command" | "invalid_params" | "command_failed";
  message: string;
  requestId: string | null;
}
```

The error shape is the single failure representation: fixed key set
(`type`, `code`, `message`, `requestId`), a closed code domain, and a
`requestId` that is present-but-null when the envelope itself could not yield
one. The adapter never throws across its boundary and never returns a bare
string or a raw `Error`.

`dispatch` enforces a strict order:

1. **Envelope validation** — reject a non-object request, or one with a missing
   or empty `requestId` / `command`, or non-object `params`.
2. **Command lookup** — reject an unknown command.
3. **Parameter validation** — each command's `validate(params)` returns a
   problem string or `null`.
4. **Effect** — only reached once steps 1-3 pass.

Steps 1-3 return an `AdapterError` and return *before* the effect, so a rejected
request can never produce a side effect. The demo's `effects` array records
every executed effect; invalid scenarios assert that its length is unchanged.

## Normalized operation results

| Scenario | Request | Result |
| --- | --- | --- |
| valid add | `{requestId:"r1", command:"add", params:{a:2,b:3}}` | `{type:"ok", requestId:"r1", value:5}` |
| non-numeric add | `{requestId:"r2", command:"add", params:{a:"2",b:3}}` | `{type:"error", code:"invalid_params", message:"add requires numeric 'a' and 'b'", requestId:"r2"}` |
| missing required param | `{requestId:"r3", command:"reverse", params:{}}` | `{type:"error", code:"invalid_params", message:"reverse requires string 'text'", requestId:"r3"}` |
| unknown command | `{requestId:"r4", command:"nope", params:{}}` | `{type:"error", code:"unknown_command", message:"Unknown command: nope", requestId:"r4"}` |
| missing requestId | `{command:"add", params:{a:1,b:1}}` | `{type:"error", code:"invalid_envelope", message:"requestId must be a non-empty string", requestId:null}` |
| non-object request | `"not-a-request"` | `{type:"error", code:"invalid_envelope", message:"request must be an object", requestId:null}` |
| thrown effect | `{requestId:"r7", command:"boom", params:{}}` | `{type:"error", code:"command_failed", message:"effect exploded", requestId:"r7"}` |

## Checks asserted by the demo

- Each error scenario returns `type: "error"`.
- Each error result matches the one stable shape (exact key set and a code from
  the closed domain).
- Each rejection scenario leaves the `effects` array unchanged (the fake effect
  did not run). The `command_failed` scenario is exempt because that command was
  dispatched and *then* threw; its effect legitimately ran.
- The valid scenario returns `ok` and records exactly one effect.
- Across all scenarios, every error shares the identical key set.

## Relationship to `packages/agent/src/proxy.ts`

The transfer is behavioral, not a copy of code:

- `streamProxy` (proxy.ts:120-265) checks `response.ok` (line 174) and throws
  before it obtains a body reader or dispatches any stream event, so a failed
  request never reaches the event-processing side effects. The adapter mirrors
  this by validating the envelope, command and params before the effect.
- The same function funnels every failure — non-OK response (line 184),
  mid-stream EOF (lines 236-242) and thrown exceptions (lines 246-256) — into
  the one `{ type: "error", reason, error }` event. The adapter funnels every
  failure into the one `AdapterError`.
- `ProxyAssistantMessageEvent` (proxy.ts:36-59) declares exactly one `error`
  variant carrying `reason`, optional `errorMessage` and `usage`, giving
  consumers a single stable failure envelope. `AdapterError` plays that role
  here.
- `processProxyEvent` (proxy.ts:270-406) rejects a delta that does not match the
  content type it targets with a thrown `Error` before mutating the partial
  message, the same "reject before applying" ordering used for param validation
  in the adapter.

## Validation and limitations

Validated by running `node .prale-eval/rpc-adapter-demo.ts`; all checks passed
and the process exited `0`. The repository's existing proxy test
(`packages/agent/test/proxy.test.ts`, which drives `streamProxy` with a stubbed
`fetch`) was not executed: workspace dependencies are not installed
(`node_modules` absent) and installing them is out of scope for this task. The
demo is self-contained precisely so it validates without that dependency.
