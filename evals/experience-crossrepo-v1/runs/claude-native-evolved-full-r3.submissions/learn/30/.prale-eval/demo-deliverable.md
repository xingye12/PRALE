# Demo deliverable — fake-transport interaction test (task 30)

## What the demo is

An executable, dependency-free interaction test that drives the real
TencentDB Agent Memory HTTP transport with a fake gateway and asserts two
contracts on the recorded request stream:

1. **Request order** — one `fetch` per `post()`, emitted in call order, with no
   hidden retry or reordering.
2. **Scope metadata** — every request carries its transport's instance scope
   headers, bound per transport and evaluated at call time.

## Artifacts

| Path | Role |
| --- | --- |
| `sdk/memory-core/typescript/tests/fake-transport.test.ts` | The interaction test (9 tests / 3 suites). |
| `sdk/memory-core/typescript/tests/resolve-ts-extensions.mjs` | Zero-dependency ESM resolve hook mapping NodeNext-style `./x.js` specifiers onto `./x.ts` sources so `src/http.ts` imports without a build. |
| `sdk/memory-core/typescript/vitest.config.ts` | One-line-equivalent `exclude` addition so the node:test suite is not collected as an empty vitest suite (mirrors the existing `tests/e2e.test.ts` precedent). |

No source files under `src/` were modified; the test imports `src/http.ts` and
`src/errors.ts` directly.

## Executable demo / normalized operation result

```sh
cd sdk/memory-core/typescript
node --import ./tests/resolve-ts-extensions.mjs --test tests/fake-transport.test.ts
```

Observed result (Node v24.14.0, native TypeScript type stripping):

```
▶ request order
  ✔ issues exactly one POST per call, in call order, to endpoint + path
  ✔ preserves global order when calls from two scoped transports interleave
  ✔ records a failed call once and continues the stream in order
✔ request order
▶ scope metadata
  ✔ attaches bearer auth + instance scope headers to every request
  ✔ omits x-tdai-user-key when the transport has no userKey
  ✔ binds scope per transport at call time, not as shared mutable state
  ✔ passes body-level scope fields through unchanged and out of the headers
✔ scope metadata
▶ envelope contract
  ✔ unwraps code===0 data and injects trace_id from the response header
  ✔ rejects with a TDAMError carrying the HTTP status on a non-2xx response
✔ envelope contract
ℹ tests 9   ℹ suites 3   ℹ pass 9   ℹ fail 0
```

## Contract under test

### Fake transport

`FakeGateway` swaps `globalThis.fetch` for a recorder. For every interaction it
captures `{ index, url, path, method, headers, body }` and returns a scripted
`Response`. `withGateway(...)` always restores the real `fetch`, so tests never
leak global state. The transport under test is constructed with
`rejectUnauthorized: true` so its TLS shim never touches `process.env`.

### Request order

- `post()` issues exactly one `fetch`; the recorded count equals the call count
  (no retry, no re-order).
- Recorded paths, methods, URLs and JSON bodies appear in call order.
- Each call receives its own endpoint's data (no response/call conflation).
- Interleaved calls from two transports keep a single global order.
- A rejected call is recorded exactly once and the following success keeps its
  position in the stream.

### Scope metadata

Asserted per recorded request, from `sdk/memory-core/typescript/src/http.ts`:

| Header | Value | Condition |
| --- | --- | --- |
| `authorization` | `Bearer <apiKey>` | always |
| `x-tdai-service-id` | `<serviceId>` | always |
| `content-type` | `application/json` | always |
| `x-tdai-user-key` | `<userKey>` | only when configured |

- Scope is bound per transport at call time: two transports with different
  `serviceId`/`apiKey`/`userKey` produce per-request scope aligned to the issuing
  transport, so interleaving does not bleed scope across instances.
- Body-level scope fields (`team_id`, `agent_id`, `user_id`, `task_id` — the
  `IdFields` in `src/types.ts`) pass through the JSON body unchanged and are not
  promoted into headers.

### Envelope contract (supporting)

- `code === 0` unwraps to `data`; `trace_id` is injected from the `x-trace-id`
  response header.
- A non-zero `code` rejects with `TDAMError` carrying `code`, `requestId`
  (`x-qcloud-transaction-id` or `envelope.request_id`) and object `data` as
  `details`.
- A non-2xx response rejects with `TDAMError` carrying the HTTP status.

## Why this boundary matters

`HttpTransport` (`sdk/memory-core/typescript/src/http.ts`, lines 27–110) is the
SDK's single egress point; `post()` (lines 65–109) is the only outbound call
path. On the server side, `MemoryCore/src/core/index.ts` re-exports
`InstanceConfigProvider` (per-`instanceId` VDB config map with TTL cache, lines
31–41) and `StorePool` (per-`instanceId` Store pool, lines 44–45), which consume
the same instance key carried by `x-tdai-service-id`. Order + scope metadata are
therefore the observable inputs that determine which instance configuration and
pooled store serve each request.

## Validation status and limitation

- **Status:** passed — 9/9 tests, 0 failures, via the command above.
- **Limitation:** the repository's declared runner is `vitest` (`package.json`
  `"test": "vitest run"`) and type-checking is `tsc`. Neither is installed — the
  workspace has no `node_modules`, and installing dependencies was out of scope.
  `npx vitest run` and `tsc --noEmit` were therefore not executed. The suite is
  authored against `node:test` so it runs with zero installs, and is excluded
  from vitest collection to avoid an empty-suite error once vitest is installed.
