# T23 — Tenant isolation demo (repo: `wattclaw`, mode: `demo`)

## What this demonstrates

Using local **fake gateway/config fixtures**, an executable demo shows the tenant
boundary of WattClaw's request → gateway dispatch path:

- an **allowed** tenant request reaches the fake gateway backend and is recorded
  there (own-tenant for a normal user; explicit cross-tenant for an admin), and
- a **mismatched** tenant request is rejected with `403 Access denied` **before**
  any call is dispatched to the backend (the backend's dispatch count is
  unchanged).

## Deliverables

| Artifact | Purpose |
| --- | --- |
| `demo/tenant-isolation-demo.mjs` | Executable Node ESM demo (no npm deps). |
| `demo/fixtures/fake-gateway-config.json` | Fake gateway/config fixture: tenants, endpoints, tokens, user→tenant assignments. |
| `.prale-eval/result.json` | Normalized result + evidence/claims/validation. |

## How to run

```bash
node demo/tenant-isolation-demo.mjs
```

No dependencies are installed in this workspace (`node_modules` is absent) and
none are installed or required. The demo uses only Node built-ins
(`node:http`, `node:fs`, `node:url`, `node:path`, `fetch`) plus the repository's
own dependency-free module `server/core/request-context.js`.

Exit code `0` means every assertion passed; `1` means a scenario failed. The
process prints a JSON report including the `backend_dispatches` log and a
`checks` array.

## Contract being demonstrated

The demo mirrors the real dispatch contract in
`server/core/multi-tenant-gateway.js`:

1. **Request-scoped dispatch is context-bound.** `MultiTenantGatewayProxy.call`
   (lines 148–151) delegates to `getGatewayForCurrentRequest()`
   (lines 397–411), which resolves the destination tenant from
   `getRequestTenant()` (line 399) — server-side request state set by
   `authMiddleware` via `runWithRequestContext` — not from a caller-supplied
   value. In the demo, `bindRequestTenant` plays the role of `authMiddleware`
   and the real `request-context.js` module supplies `getRequestTenant()` /
   `getRequestUser()`.

2. **Cross-tenant routing is an explicit, separate API.**
   `callGatewayForTenant(tenantId, …)` (lines 417–424) deliberately *bypasses*
   request-context selection and is used by admin/aggregation flows. Ordinary
   (non-admin) request handling never routes to a foreign tenant, so a mismatch
   is rejected before dispatch. The demo encodes this as: a non-admin request
   whose explicit target tenant differs from the bound tenant throws
   `Error('Access denied')` with `statusCode 403` prior to `fetch`-ing the fake
   backend; an admin request may cross tenants and does reach the backend.

3. **Mismatch is dropped, not forwarded.** The same "skip on mismatch" rule
   exists for SSE delivery in `server/core/sse.js:23`; the demo asserts the
   equivalent observable — the fake backend receives nothing for the mismatched
   request.

## Normalized result

Running the demo produces (abridged) the following normalized report:

```json
{
  "task": "T23",
  "demo": "tenant-isolation",
  "backend_dispatches": [
    { "tenantId": "tenant-1", "method": "session.list", "token": "openclaw-token-tenant-1-fixture" },
    { "tenantId": "tenant-2", "method": "config.get",   "token": "openclaw-token-tenant-2-fixture" }
  ],
  "checks": [
    { "name": "allowed_own_tenant_reaches_backend", "ok": true, "detail": { "routedTo": "tenant-1", "backendCalls": 1 } },
    { "name": "allowed_request_binds_own_tenant",   "ok": true, "detail": { "boundTenantId": "tenant-1", "routedTenantId": "tenant-1" } },
    { "name": "mismatched_tenant_rejected",         "ok": true, "detail": { "message": "Access denied", "statusCode": 403 } },
    { "name": "mismatched_tenant_not_dispatched",   "ok": true, "detail": { "backendCalls": 1, "expected": 1 } },
    { "name": "admin_cross_tenant_reaches_backend", "ok": true, "detail": { "routedTo": "tenant-2", "backendCalls": 2 } }
  ],
  "passed": true
}
```

Interpretation:

- `tenant-1` records the allowed own-tenant request from `alice`; `tenant-2`
  records only the admin cross-tenant request. The mismatched `alice → tenant-2`
  attempt produced no backend entry.

## Scope / limitations

- The fixture substitutes the Docker/SQLite tenant manager with plain records so
  the demo runs offline; it reproduces the *dispatch-selection and pre-dispatch
  rejection contract* rather than container lifecycle.
- No task metadata, hidden-oracle files, package locks, or git configuration
  were modified. The only non-artifact additions are the demo script and its
  fixture.
