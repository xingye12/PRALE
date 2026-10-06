# T11 — Contract: panel route rejects missing/invalid required headers

Repository: `tdam` (MemoryPanel / Control panel)
Mode: `contract`

## 1. What is being contracted

The panel's HTTP layer has one shared header guard,
`validatePanelMetaHeaders(deps)` in
`MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts`. Every panel
route that needs a resolved memory instance wraps itself with it.

The earlier contract covered the `POST /api/v1/meta/*` proxy. This task contracts
a **different route**: the skill data-plane proxy

```
POST /api/v1/skill/{action}      (action ∈ skill-actions.ts, e.g. `get`)
```

registered by `registerSkillProxyRoutes()` in
`MemoryPanel/src/panel/http/routes/skill/proxy.ts`. The route is "different"
because it is a distinct registration path with its own downstream client
(`deps.skillKernel`, the `/v3/skill/*` adapter) rather than `deps.metaKernel`,
yet it reuses the same middleware, so the header contract must hold identically.

## 2. The contract

Required inbound headers (`MemoryPanel/src/panel/kernel/headers.ts`):

| Header | Meaning |
|---|---|
| `x-tdai-service-id` (`META_HEADER_SERVICE_ID`) | selects the instance to resolve |
| `x-tdai-user-key` (`META_HEADER_USER_KEY`) | caller user key (skip only for the `auth/verify` action) |

For `POST /api/v1/skill/{action}` the middleware's `readAction()`/`action` is the
skill action (e.g. `get`), never `auth/verify`, so `x-tdai-user-key` is always
required.

Rejection contract — the guard returns **before** `await next()`, so the route
handler never runs and the downstream client is never called:

| Request | HTTP | Envelope `code` | Envelope `message` |
|---|---|---|---|
| no `x-tdai-service-id` (or blank) | 400 | 400 | `MISSING_INSTANCE_ID` |
| `x-tdai-service-id` that the registry cannot resolve | 400 | 400 | `INVALID_INSTANCE` |
| valid instance, no `x-tdai-user-key` (or blank) | 400 | 400 | `MISSING_USER_KEY` |
| both headers present and valid | 200 | 0 | `ok` (handler runs, kernel called) |

All three rejections use the standard control envelope:

```json
{ "code": 400, "message": "MISSING_INSTANCE_ID", "request_id": "<id>", "data": null }
```

built by `respondControlError` → `controlEnvelope`
(`MemoryPanel/src/panel/http/envelope.ts`) and mapped to HTTP status by
`mapHttpStatusFromEnvelopeCode` (`MemoryPanel/src/panel/kernel/envelope.ts`),
which maps `code` 400–599 straight to the HTTP status.

## 3. Executable demo

`MemoryPanel/tests/panel/contract-skill-proxy-headers.test.ts` (vitest, matches
the repo's `vitest.config.ts` include glob `tests/**/*.test.ts`).

The demo builds a real `Hono` app, mounts only the real skill proxy route
(`registerSkillProxyRoutes(api, deps)` under `/api/v1`), and injects a fake
downstream client:

```ts
const invoke = vi.fn(async () => ({ code: 0, message: 'ok', request_id: '', data: { ok: true } }));
const deps = { instanceRegistry: new InstanceRegistry([...]), skillKernel: { invoke } } as unknown as PanelDeps;
```

Cases asserted:

1. missing `x-tdai-service-id` → HTTP 400 + `{code:400,message:'MISSING_INSTANCE_ID',request_id,data:null}` + `invoke` not called;
2. unknown `x-tdai-service-id` → HTTP 400 + `INVALID_INSTANCE` + `invoke` not called;
3. missing `x-tdai-user-key` → HTTP 400 + `MISSING_USER_KEY` + `invoke` not called;
4. whitespace-only headers are treated as missing → `MISSING_INSTANCE_ID` + `invoke` not called;
5. **reachability proof** — the same request with valid headers returns 200 / `code:0` and `invoke` is called exactly once with action `get`.

Case 5 is what makes cases 1–4 meaningful: it proves the fake client is properly
wired to the route, so "not called" reflects the middleware short-circuit rather
than an unrelated/unregistered route.

Run it with:

```
cd MemoryPanel && npx vitest run tests/panel/contract-skill-proxy-headers.test.ts
```

### Validation status

The workspace fixture ships **no `node_modules`** for `MemoryPanel` (no `hono`,
no `vitest`), and dependency installation is explicitly out of scope for this
task. `npm test -- tests/panel/contract-skill-proxy-headers.test.ts` therefore
fails with `sh: 1: vitest: not found`, and `npx --no-install vitest ...` reports
the missing package. This limitation is recorded in the `validation` object of
`.prale-eval/result.json`; the command above is the exact reproduction once the
repo's dependencies are installed.

## 4. Evidence map

| File | Symbol | Lines | Task-relevant behaviour |
|---|---|---|---|
| `MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts` | `validatePanelMetaHeaders` | 31–63 | The guard: reads `x-tdai-service-id`, resolves instance (400 `INVALID_INSTANCE`), requires `x-tdai-user-key` unless action is `auth/verify`, sets `panelMeta`, and only then `await next()`. Every rejection `return`s before `next()`. |
| `MemoryPanel/src/panel/http/routes/skill/proxy.ts` | `registerSkillProxyRoutes` | 26–52 | The contracted different route: `api.post('/skill/*', validatePanelMetaHeaders(deps), handler)`; only the handler (after `next()`) calls `deps.skillKernel.invoke`. |
| `MemoryPanel/src/panel/http/envelope.ts` | `respondControlError` | 22–25 | Builds the standard control envelope and emits it with the mapped HTTP status. |
| `MemoryPanel/src/panel/kernel/envelope.ts` | `mapHttpStatusFromEnvelopeCode` | 11–15 | Standard envelope `code` → HTTP status mapping (`code===0`→200, 400–599→code). |
| `MemoryPanel/src/panel/config/instance-registry.ts` | `InstanceRegistry.resolve` | 96–100 | Unknown instance throws `InstanceRegistryError(400)` which the middleware converts to `INVALID_INSTANCE`. |
| `MemoryPanel/src/panel/kernel/headers.ts` | `META_HEADER_SERVICE_ID` / `META_HEADER_USER_KEY` | 5–6 | Canonical header names used by the guard. |
| `MemoryPanel/tests/panel/contract-skill-proxy-headers.test.ts` | `describe('contract: POST /api/v1/skill/* required headers')` | 79–156 | The executable contract demo asserting envelope shape, status, and no downstream call. |
