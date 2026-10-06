# Demo — write-then-scoped-read against a local fake HTTP backend (`tdma` / T27)

Executable demo that drives the **real** v3 TypeScript SDK
(`sdk/memory-core/typescript/src/v3/client.ts` → `MemoryClient`) against a loopback
`node:http` server and asserts three things on the wire:

1. **request order** — the write POST is issued before the scoped read POST;
2. **scope metadata** — the `team_id` / `agent_id` / `user_id` isolation triple is on
   every body, and narrowing scope drops `task_id` entirely;
3. **normalized result** — the `{code, message, request_id, data}` envelope is unwrapped
   to `data`, `x-trace-id` is merged onto the result, and `undefined` fields never ship.

## Run

Zero installed dependencies; the bundled Node runtime executes the TypeScript sources
directly (Node ≥ 22.7, validated on v24.14.0):

```bash
node --experimental-transform-types \
     --import ./.prale-eval/demo/register.mjs \
     ./.prale-eval/demo/run-demo.mjs
```

Exit code `0` = all 7 checks pass; `1` = at least one check failed (the JSON report lists
each check with `ok` and, on failure, a `detail`).

## Files

| Path | Role |
| --- | --- |
| `demo/run-demo.mjs` | Executable demo: fake backend, SDK client, assertions, JSON report |
| `demo/loader.mjs` | Node resolve hooks: bare `undici` → shim; `./x.js` (absent) → `./x.ts` |
| `demo/register.mjs` | Registers the loader via `module.register` |
| `demo/undici-shim.mjs` | No-op `Agent` stub — `undici` is not installed in this checkout |

## Contract exercised

The demo does **not** hand-roll HTTP. It instantiates the real transport through the
public config constructor:

```ts
const client = new MemoryClient({ endpoint, apiKey, serviceId, teamId, agentId, userId, sessionId, taskId });
```

so the observed wire traffic comes from the SDK's own code paths:

* **Scope.** `IsolationContext.baseBody()` builds `team_id` / `agent_id` / `user_id` /
  `task_id` from the constructor; each call merges that base body with per-call fields and
  passes it through `stripUndefined()`. The scoped read uses
  `client.withIsolation({ taskId: null })`, so the narrowed client's `baseBody()` omits
  `task_id` — it is **absent from the JSON**, not present-and-null. The fake backend also
  rejects any request missing the triple (`40001`), so a passing run proves the SDK
  emitted the scope rather than the test assuming it.
* **Order.** Both operations are awaited sequentially over one transport instance, so the
  server's arrival log must be exactly `POST /v3/scenario/write`, `POST /v3/scenario/read`.
* **Normalization.** `V3HttpTransport.request()` parses the envelope, throws when
  `code !== 0` or the HTTP status is not ok, returns `envelope.data`, and stamps
  `trace_id` from the `x-trace-id` response header. The demo asserts the result equals the
  raw `data` payload **plus** `trace_id`, and that no envelope field (`code`, `message`,
  `request_id`, `data`) leaks onto it.

## Observed run

```
request_order: ["POST /v3/scenario/write", "POST /v3/scenario/read"]

write_body:  {team_id: team-alpha, agent_id: agent-alpha, user_id: user-alpha,
              task_id: task-alpha, path: notes/cross-repo-transfer.md,
              content: "# Cross-repo transfer\n\ntdma demo note\n", summary: demo note}
read_body:   {team_id: team-alpha, agent_id: agent-alpha, user_id: user-alpha,
              path: notes/cross-repo-transfer.md}          # task_id / session_id absent

write_result: {path, updated_at, trace_id: "trace-write-1"}
read_result:  {path, content: <round-tripped note>, created_at, updated_at,
               trace_id: "trace-read-1"}

status: PASS — 7/7 checks
```

## Environment limitation

This checkout has **no `node_modules`** and no `tsc` / `tsx` / `vitest` binary, and the
task forbids installing dependencies. The `.js`-suffixed TS specifiers the SDK uses
(`import { X } from "../errors.js"`) and the bare `undici` dependency therefore cannot be
resolved by Node as-is, so `demo/loader.mjs` supplies both rewrites at resolve time.
Consequently the repo's own `pnpm test` (vitest) suite could not be executed; the demo
above is the substitute validation and it exercises the same transport/normalization code
the vitest suite would.
