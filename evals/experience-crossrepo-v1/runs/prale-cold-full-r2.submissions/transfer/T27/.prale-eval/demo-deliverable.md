# T27 demo deliverable — executable write-then-scoped-read demo (repo `tdam`)

## What was delivered

A **runnable demo** that drives the un-built TypeScript SDK in
`sdk/memory-core/typescript/` against a **local fake HTTP backend**, performs
**one write followed by one scoped read**, and asserts:

1. **request order** — exactly two HTTP requests, in the order
   `POST /v3/conversation/add` → `POST /v3/conversation/query`;
2. **scope metadata** — every request body carries the strict-isolation scope
   (`team_id`, `agent_id`, `user_id`, `session_id`) resolved from the client
   configuration, and requests are authenticated with the configured
   credentials (`Authorization: Bearer …`, `x-tdai-service-id: …`,
   `Content-Type: application/json`);
3. **normalized result** — the SDK unwraps the `{code,message,data}` envelope
   into the bare `data` object and re-attaches the `x-trace-id` response header
   as `trace_id`, for both the write and the read, and the scoped read returns
   **only** rows inside the requested scope.

## Run it

```bash
node ./.prale-eval/demo/run-demo.mjs
```

Exit code `0` = all checks passed, `1` = at least one check failed. The demo
prints a JSON report (requests observed on the wire, normalized results, per
check verdicts) and tears the backend down again.

No build step, no `npm install`: Node 24 executes the SDK sources natively, and
the demo adds only local shims (see *Executability* below).

## Artifacts

| Path | Role |
| --- | --- |
| `.prale-eval/demo/demo.mts` | The demo itself: fake `node:http` backend, SDK client, 7 assertions, JSON report |
| `.prale-eval/demo/run-demo.mjs` | Entrypoint: ensures `--experimental-transform-types`, registers the resolution hook, imports `demo.mts` |
| `.prale-eval/demo/sdk-resolve-hooks.mjs` | Node resolution hook: `./x.js` → `./x.ts` for the un-built SDK sources, plus the `undici` stub mapping |
| `.prale-eval/demo/undici-stub.mjs` | Never-instantiated stand-in for the uninstalled `undici` dependency (`Agent` is only imported statically by `src/v3/http.ts`) |

No repository file was modified; nothing outside `.prale-eval/` was added.

## Contract the demo pins down

Backend endpoint: `http://127.0.0.1:<ephemeral port>` (`server.listen(0)`), so
the demo cannot collide with anything else. The two SDK calls under test come
from `sdk/memory-core/typescript/src/v3/client.ts` (`MemoryClient`), which posts
through `V3HttpTransport` (`sdk/memory-core/typescript/src/v3/http.ts`).

**1. Write** — `client.addConversation({ messages: [...] })`:

```http
POST /v3/conversation/add
Authorization: Bearer sk-mem-demo-key
x-tdai-service-id: mem-instance-demo
Content-Type: application/json

{"team_id":"team-demo-42","agent_id":"agent-demo-42","user_id":"user-demo-42",
 "session_id":"session-demo-42","messages":[{"role":"user","content":"hello from the T27 demo"},
 {"role":"assistant","content":"ack"}]}
```

The write path demands a non-empty `session_id` (`resolveSessionForWrite`, which
throws instead of letting a session-less write land in a default bucket).

**2. Scoped read** — `client.queryConversation({ limit: 20 })`:

```http
POST /v3/conversation/query
Content-Type: application/json

{"team_id":"team-demo-42","agent_id":"agent-demo-42","user_id":"user-demo-42",
 "session_id":"session-demo-42","limit":20}
```

`stripUndefined()` removes absent filters, so the body contains exactly those
five keys — no `offset`/`time_start`/`time_end` leakage. The read reuses the
constructor session, i.e. it is **scoped**, not cross-session.

**3. Envelope → normalized result.** The backend answers with the v3 envelope
plus a trace header:

```json
{"code":0,"message":"ok","request_id":"req-write-1",
 "data":{"accepted_ids":["msg-1","msg-2"],"total_count":2}}
```

```json
{"code":0,"message":"ok","request_id":"req-read-1",
 "data":{"messages":[{"id":"msg-1","role":"user","content":"hello from the T27 demo"},
                     {"id":"msg-2","role":"assistant","content":"ack"}],"total":2}}
```

`V3HttpTransport.request` returns `envelope.data` only (envelope keys are gone)
and injects `trace_id` from `x-trace-id`, yielding the normalized results the
demo compares against:

```json
{
  "write": {"accepted_ids": ["msg-1", "msg-2"], "total_count": 2, "trace_id": "trace-write-1"},
  "read": {
    "messages": [
      {"id": "msg-1", "role": "user", "content": "hello from the T27 demo"},
      {"id": "msg-2", "role": "assistant", "content": "ack"}
    ],
    "total": 2,
    "trace_id": "trace-read-1"
  }
}
```

The backend is pre-seeded with two rows in the *same* team+agent but a
**different user** and a **different session**; neither appears in the read,
which is what makes the scope-metadata check meaningful rather than vacuous.

## Verified result (`node ./.prale-eval/demo/run-demo.mjs`, exit code 0)

```
request order: exactly one write, then one scoped read ................. PASS
  observed order = ["POST /v3/conversation/add","POST /v3/conversation/query"]
write request carries the full isolation scope ........................ PASS
  team_id/agent_id/user_id/session_id all match the client scope
write request authenticates with the configured credentials ........... PASS
  authorization="Bearer sk-mem-demo-key", x-tdai-service-id="mem-instance-demo",
  content-type="application/json"
scoped read reuses the isolation scope and the configured session ..... PASS
  team_id/agent_id/user_id/session_id all match; limit=20;
  undefined fields stripped from body = true
normalized write result: envelope unwrapped + trace_id normalized ..... PASS
  {"accepted_ids":["msg-1","msg-2"],"total_count":2,"trace_id":"trace-write-1"}
normalized scoped read result: only in-scope messages, envelope unwrapped
+ trace_id normalized ................................................. PASS
  {"messages":[{"id":"msg-1",...},{"id":"msg-2",...}],"total":2,
   "trace_id":"trace-read-1"} (foreign user/session seed rows excluded)
Transport seam: MemoryClient accepts an injected Transport and re-scopes
without extra HTTP traffic ............................................ PASS
  injected-transport calls=0, backend requests=2
passed: true
```

## Executability notes / limitations

* `node_modules` is absent and installing dependencies is out of scope, so the
  packaged `npm test` (vitest) and `npx tsc --noEmit` suites cannot be run here;
  the demo is a self-contained executable check instead and needs only Node ≥ 22
  (verified on Node v24.14.0).
* The SDK sources are authored with `moduleResolution: bundler` (`.js`
  specifiers pointing at `.ts` files) and use TypeScript parameter properties in
  `IsolationContext`, so the demo maps `.js` → `.ts` through a Node resolution
  hook and runs Node in `--experimental-transform-types` mode (the entrypoint
  re-executes itself with the flag if it was not passed). This does not change
  the SDK code paths under test — the real `MemoryClient` and `V3HttpTransport`
  execute unmodified.
* `undici` (used by `V3HttpTransport` only for the `rejectUnauthorized: false`
  TLS dispatcher) is replaced by a local stub; the demo uses plain HTTP against
  loopback and never instantiates it.
* Negative control: a throwaway copy of `demo.mts` with one assertion
  deliberately broken (`limit === 99`) exited `1` with `passed: false`, i.e. the
  assertions are effective; that copy was deleted afterwards.
