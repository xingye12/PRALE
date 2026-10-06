# T23 demo deliverable — multi-tenant gateway routing / isolation

## What this demonstrates

Using local fake gateway/config fixtures, the demo shows both halves of the
tenant isolation contract:

| Scenario | Request | Outcome |
| --- | --- | --- |
| Allowed | bound to `tenant-1`, no override | dispatched → fake backend for `tenant-1` answers HTTP 200 and records 1 dispatch |
| Mismatched | bound to `tenant-1`, asks for `tenant-2` | rejected with **403 before dispatch**; `tenant-2` backend records **0** dispatches |
| Unknown | asks for `tenant-9` | rejected with `Tenant tenant-9 not found` before dispatch |

Final backend dispatch counts: `tenant-1 = 1`, `tenant-2 = 0`.

## Executable demo

```bash
node .prale-eval/demo/tenant-routing-demo.mjs
```

Exit code `0` means every assertion passed. The script is self-contained:
stdlib only (Node ≥ 18 for global `fetch`), no `node_modules`, no Docker, no live
Gateway. The real module imports `better-sqlite3` and `ws`, which are not
installed in this environment, so the demo re-implements only the routing
decision with the source line references kept inline and verified at runtime.

### Files

- `.prale-eval/demo/tenant-routing-demo.mjs` — the executable demo.
- `.prale-eval/demo/fixtures/tenants.json` — fake OpenClaw tenant registry
  (two tenants + one user assignment), the shape `normalizeTenant()` reads from
  `openclaw_tenants` / `user_tenant_assignments`.
- `.prale-eval/demo/fixtures/fake-gateway-config.json` — fake `envConfig` fixture
  (`OPENCLAW_MULTI_TENANT`, port base, public host/protocol), the shape
  `resolveConfig()` consumes.

### How each scenario works

1. **Fake backends** — `createFakeGatewayBackend(tenant)` starts one
   `node:http` server per fixture tenant on `127.0.0.1:<port>` implementing the
   gateway HTTP endpoint (`POST /api/v1/admin/rpc`). Every received request is
   recorded with its `Authorization` header, so "did the request reach the
   backend?" is answered by an exact count, not by inspection.
2. **Routing** — `selectTenantForRequest()` mirrors
   `server/core/multi-tenant-gateway.js`:
   - context tenant wins, else the authenticated user's assigned tenant
     (`getGatewayForCurrentRequest` lines 397–411 /
     `getHttpTargetForCurrentRequest` lines 448–466);
   - an explicit tenant id is resolved with the same existence guard as
     `callGatewayForTenant` (lines 417–424) /
     `getHttpTargetForTenantId` (lines 468–485): `Tenant ${tenantId} not found`,
     thrown **before** the WS client / target is built;
   - a tenant that differs from the request's bound tenant is refused (403)
     **before** `buildHttpTarget()` runs — i.e. before any socket is opened.
3. **Dispatch** — `buildHttpTarget()` returns the same
   `{ baseUrl: http://host:port, headers: { Authorization: Bearer <token> }, tenant }`
   shape as `getHttpTargetForCurrentRequest()` (lines 461–465), and `dispatch()`
   posts to `/api/v1/admin/rpc`.

## Contract / normalized operation result

`dispatch()` returns a normalized record and the script prints a JSON summary:

```json
{
  "task": "T23",
  "ok": true,
  "backendDispatchCounts": { "tenant-1": 1, "tenant-2": 0 },
  "scenarios": [
    { "scenario": "allowed",    "tenantId": "tenant-1", "baseUrl": "http://127.0.0.1:19791", "dispatched": true,  "status": 200 },
    { "scenario": "mismatched", "requestedTenantId": "tenant-2", "rejected": true, "error": "Tenant mismatch: request bound to tenant-1 cannot dispatch to tenant-2", "dispatched": false },
    { "scenario": "unknown",    "requestedTenantId": "tenant-9", "rejected": true, "error": "Tenant tenant-9 not found", "dispatched": false }
  ],
  "checks": 18,
  "failures": []
}
```

## Grounding in the repository

The demo starts by reading `server/core/multi-tenant-gateway.js` and asserting
that the cited symbols still occupy the cited inclusive line ranges. If the
source drifts, the demo fails loudly instead of reporting a stale contract:

| Symbol | Lines |
| --- | --- |
| `getGatewayForCurrentRequest` / `MultiTenantGatewayProxy` request path | 397–411 |
| `callGatewayForTenant` | 417–424 |
| `getHttpTargetForCurrentRequest` | 448–466 |
| `getHttpTargetForTenantId` | 468–485 |

Supporting context: `ensureUserTenant` (353–395) binds the fallback tenant and
`normalizeTenant` (2052–2065) supplies the `host`/`port`/`token` used in the
dispatch target.

## Validation

```bash
$ node .prale-eval/demo/tenant-routing-demo.mjs
...
  PASS  lines 397-411 contain getGatewayForCurrentRequest()
  PASS  request routed to tenant-1
  PASS  tenant-1 fake backend recorded exactly 1 dispatch
  PASS  mismatched request was rejected
  PASS  rejection status is 403 (forbidden)
  PASS  tenant-2 fake backend recorded 0 dispatches (rejected before dispatch)
  PASS  error matches the source wording "Tenant tenant-9 not found"
  PASS  total fake-backend dispatches across all scenarios is 1 (got 1)
EXIT=0
```

**Limitation:** this validates the routing decision and the pre-dispatch
existence/mismatch guard against fake fixtures. It does not boot a live OpenClaw
container or the real `ws` gateway client (dependencies are not installed here).
