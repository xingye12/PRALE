# T09 — tdam demo: write → scoped read over a local fake HTTP backend

Task mode: **demo** · Repository: **tdam** (TencentDB Agent Memory monorepo)

## What is delivered

An executable, dependency-free demo that drives the repository's **real** TypeScript
v3 SDK against a **local fake HTTP backend** and verifies three properties of the
resulting operation: **request order**, **scope metadata**, and **normalized result**.

| Artifact | Purpose |
|----------|---------|
| `.prale-eval/demo/run-demo.mjs` | Fake backend + demo + assertions (entry point) |
| `.prale-eval/demo/loader.mjs` | Self-contained Node resolve hook (SDK `./x.js` → `./x.ts`, `undici` stub) |
| `.prale-eval/demo/undici-stub.mjs` | No-op `Agent` so the unused `undici` import resolves |
| `.prale-eval/result.json` | Machine-readable task result with evidence/claims/validation |

## How to run

```bash
# from the repository root
node --experimental-transform-types .prale-eval/demo/run-demo.mjs
```

Expected: `13/13 checks passed` and exit code 0.

No dependencies are installed and no repository source file is modified. The
`--experimental-transform-types` flag is required only because the SDK sources use
TypeScript parameter properties, which Node's strip-only mode rejects.

## The fake backend

The demo starts a `node:http` server on `127.0.0.1:<ephemeral>` that speaks the
SDK's `/v3/*` envelope contract:

* Request bodies arrive as JSON with the isolation scope merged in.
* Responses are `{ "code": 0, "message": "ok", "request_id": "req-N", "data": {...} }`
  with an `x-trace-id: trace-N` response header.

Routes:

| Route | Behavior |
|-------|----------|
| `POST /v3/scenario/write` | Stores `{content, summary}` under `team/agent/user/path`, returns `{path, updated_at}` |
| `POST /v3/scenario/read` | Returns `{path, content, created_at, updated_at}` (nulls if absent); `path == "__error__"` returns `code: 5001` |

Every request is recorded with its sequence number, path, parsed body, auth headers,
and start/complete timestamps so the demo can assert on the raw wire traffic.

## The demo flow (one write, then one scoped read)

```ts
const client = new MemoryClient({
  endpoint,            // the fake backend URL
  apiKey: "demo-bearer-token",
  serviceId: "memory-demo-1",
  teamId: "team-demo",
  agentId: "agt-demo",
  userId: "usr-demo",
  sessionId: "sess-demo",   // L2/L3 ignore session scope (asserted)
  rejectUnauthorized: true,
});

const writeResult = await client.writeScenario({ path: "notes/demo.md", content: "hello from the write", summary: "demo note" });
const readResult  = await client.readScenario({ path: "notes/demo.md" });
```

Observed wire sequence (verbatim from the run):

```
1. POST /v3/scenario/write  body={"team_id":"team-demo","agent_id":"agt-demo","user_id":"usr-demo","path":"notes/demo.md","content":"hello from the write","summary":"demo note"}
2. POST /v3/scenario/read   body={"team_id":"team-demo","agent_id":"agt-demo","user_id":"usr-demo","path":"notes/demo.md"}
3. POST /v3/scenario/read   body={"team_id":"team-demo","agent_id":"agt-demo","user_id":"usr-demo","path":"notes/missing.md"}
4. POST /v3/scenario/read   body={"team_id":"team-demo","agent_id":"agt-demo","user_id":"usr-demo","path":"__error__"}
```

Normalized results:

```
write: {"path":"notes/demo.md","updated_at":"<iso>","trace_id":"trace-1"}
read : {"path":"notes/demo.md","content":"hello from the write","created_at":"<iso>","updated_at":"<iso>","trace_id":"trace-2"}
```

## Contract and verification matrix

| # | Property | Assertion | Grounding |
|---|----------|-----------|-----------|
| 1 | Order | first request is the write, second is the read | `MemoryClient.writeScenario` / `readScenario` (`src/v3/client.ts`) |
| 2 | Order | write response `completedAt` ≤ read `startedAt` (read not sent until write resolves) | `await` sequencing in the demo |
| 3 | Scope | write body carries `team_id`/`agent_id`/`user_id` = constructed scope | `IsolationContext.baseBody` (`src/v3/client.ts`) |
| 4 | Scope | read body carries the same scope trio | `readScenario` spreads `baseBody()` |
| 5 | Scope | neither L2 request leaks `session_id` | `baseBody()` never includes session |
| 6 | Payload | write body keys = scope + `path`/`content`/`summary` | `writeScenario` |
| 7 | Payload | read body keys = scope + `path` only (no write fields) | `readScenario` |
| 8 | Normalize | write result = unwrapped `{path, updated_at}`, no `code`/`message`/`request_id` | `V3HttpTransport` envelope unwrap |
| 9 | Normalize | read result content equals what was written | envelope `data` return |
| 10 | Normalize | `trace_id` copied from the `x-trace-id` response header | `V3HttpTransport.request` |
| 11 | Normalize | missing document → `content`/`created_at`/`updated_at` are `null` | `ScenarioFile` normalization |
| 12 | Normalize | non-zero `code` → `TDAMError` (5001) with header-derived `requestId` | `V3HttpTransport.request` error branch |
| 13 | Auth | every request carries `Authorization: Bearer …` + `x-tdai-service-id` | `V3HttpTransport` headers |

## Limitations recorded

* The workspace has no installed `node_modules` (no `vitest`, `typescript`, or
  `undici`) and installing was not permitted, so the SDK's own `npm test` suite could
  not be executed. The demo therefore uses Node's native TypeScript support plus a
  minimal resolve hook as the harness.
* The `--experimental-transform-types` flag and the resolve hook are demo-scaffolding
  only; they do not alter SDK behavior or repository sources.
* Assertions 9/10/11/12 rely on a single-run live capture; the backend is deterministic
  and bound to an ephemeral port, so `trace-N` ids are stable per run.
