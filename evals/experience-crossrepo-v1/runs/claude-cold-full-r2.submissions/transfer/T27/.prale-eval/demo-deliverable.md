# T27 demo — write-then-scoped-read against a local fake HTTP backend

Repository: `tdam` · Mode: `demo` · Task: `T27`

## What this deliverable is

An executable, dependency-free demo that drives the **real, unbuilt** TencentDB
Agent Memory SDK against a **local fake HTTP backend**, performing one write and
then one scoped read, and verifying **request order**, **scope metadata** and the
**normalized operation result**.

Nothing in the SDK source was modified. The demo exercises production code:

| Layer | File | Role in the demo |
| --- | --- | --- |
| Client | `sdk/memory-core/typescript/src/v3/client.ts` | `MemoryClient` — isolation context, `addConversation` / `queryConversation` bodies, `withIsolation` |
| Transport | `sdk/memory-core/typescript/src/v3/http.ts` | `V3HttpTransport` — request headers, envelope unwrapping, `trace_id` |
| Seam | `sdk/memory-core/typescript/src/client.ts` | `MemoryClientConfig` (connection scope) and `Transport` (injectable boundary) |
| Demo | `sdk/memory-core/typescript/demo/fake-backend-demo.mjs` | fake backend + assertions |
| Demo shims | `demo/loader.mjs`, `demo/undici-stub.mjs` | dependency-free module resolution (see Limitations) |

## Run it

```bash
cd sdk/memory-core/typescript
node --experimental-transform-types demo/fake-backend-demo.mjs
```

Expected: an 8-line check report ending in `8/8 checks passed`, exit code `0`.

## The contract being demonstrated

`MemoryClientConfig` (`src/client.ts:8-19`) fixes the connection scope of every
call — `endpoint`, `apiKey`, `serviceId`. The transport turns those into
`Authorization: Bearer <apiKey>`, `x-tdai-service-id: <serviceId>` and
`Content-Type: application/json`.

`Transport` (`src/client.ts:24-28`) is the substitutable HTTP boundary: a
required `post<T>(path, body)` and an optional `get?<T>(path, query)`. This is
the seam the demo replaces with a loopback `node:http` server — the SDK's own
`V3HttpTransport` still satisfies it, so the demo runs the production transport
code rather than a hand-written stub.

Each call is also scoped by the strict-isolation context (`team_id`, `agent_id`,
`user_id`, optional `session_id`, `task_id`) merged into the POST body, with
`undefined` fields stripped before serialization.

The server replies with the `ApiResponseEnvelope` shape
`{ code, message, request_id, data }`. The transport treats it as normalized:
`code === 0` → return `data`; otherwise throw `TDAMError(code, message,
request_id)`. A response `x-trace-id` header is attached to the returned object
as `trace_id`.

## Observed transcript

Fake backend request log (from an actual run):

```
#1 POST /v3/conversation/add
   body={"team_id":"team-alpha","agent_id":"agent-qa","user_id":"user-42",
         "session_id":"session-2026-10-03",
         "messages":[{"role":"user","content":"remember: T27 demo"}]}
#2 POST /v3/conversation/query
   body={"team_id":"team-alpha","agent_id":"agent-qa","user_id":"user-42",
         "session_id":"session-2026-10-03","limit":10}
#3 POST /v3/conversation/query
   body={"team_id":"team-alpha","agent_id":"agent-qa","user_id":"user-77","limit":10}
```

Headers on every request: `authorization: Bearer demo-api-key`,
`x-tdai-service-id: svc-demo-0001`, `content-type: application/json`.
`task_id` is absent from every body — it was never provided, and undefined
fields are stripped rather than serialized as `null`.

### Normalized operation result

Backend envelope for the write:

```json
{ "code": 0, "message": "ok", "request_id": "req-write-1",
  "data": { "accepted_ids": ["msg-1001"], "total_count": 1 } }
```
with response header `x-trace-id: trace-write-1`. What `addConversation`
resolves to:

```json
{ "accepted_ids": ["msg-1001"], "total_count": 1, "trace_id": "trace-write-1" }
```

Backend envelope for the read carries `data.messages[...]` and `data.total: 1`
with `x-trace-id: trace-read-1`; `queryConversation` resolves to
`{ messages: [...], total: 1, trace_id: "trace-read-1" }`.

In both cases the envelope's `code` / `message` / `request_id` keys do **not**
leak into the resolved value — only `data` (plus `trace_id`) is returned.

## Verification performed

| # | Check | Result |
| --- | --- | --- |
| 1 | Write POST `/v3/conversation/add` is recorded strictly before read POST `/v3/conversation/query` (exactly 3 requests total, all `POST`) | PASS |
| 2 | Every request carries bearer token, `x-tdai-service-id`, `Content-Type: application/json` | PASS |
| 3 | Write body carries the full isolation scope (`team_id`/`agent_id`/`user_id`/`session_id`) with `task_id` stripped | PASS |
| 4 | Read body carries the same isolation scope plus the read's own `limit` | PASS |
| 5 | `withIsolation({ userId: "user-77", sessionId: null })` rewrites `user_id` and drops `session_id`, keeping the other scope fields | PASS |
| 6 | Write result is the unwrapped envelope `data` (+ `trace_id`); no envelope keys leak | PASS |
| 7 | Read result is the unwrapped envelope `data` (+ `trace_id`); no envelope keys leak | PASS |
| 8 | Narrowed read result is normalized identically | PASS |

Validation artifact: `.prale-eval/result.json` → `validation.command =
"node --experimental-transform-types demo/fake-backend-demo.mjs"`, `status =
"passed"` (exit 0, 8/8).

## Limitations

The fixture has **no `node_modules`**, and installing dependencies was not
permitted, so `undici`, `typescript`/`tsc` and `vitest` are unavailable. This was
worked around without touching SDK sources:

- `demo/loader.mjs` is an ESM resolve hook that (a) maps the `undici` import in
  `src/v3/http.ts` to `demo/undici-stub.mjs` — the `Agent` dispatcher is only
  constructed when `rejectUnauthorized === false`, which this demo never sets, so
  the stub is loaded but never instantiated — and (b) rewrites the SDK's
  NodeNext-style `./x.js` specifiers onto their `.ts` sources.
- Node's strip-only type support rejects the TypeScript parameter property used
  by `IsolationContext` in `src/v3/client.ts`, so `--experimental-transform-types`
  is required. It prints an experimental-feature warning on stderr; assertions
  and exit code are unaffected.

Consequently the demo was **not** type-checked with the project `tsconfig.json`,
and the package's `vitest` suite was not run (vitest is not installed and the
fixture ships no `tests/` directory). The demo asserts runtime behavior only.
