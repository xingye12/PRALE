# T24 demo — fake gateway/config tenant dispatch

## What this demonstrates

Using **local fake gateway/config fixtures** (no Docker, no real OpenClaw image), the
demo shows the multi-tenant routing boundary of `server/core/multi-tenant-gateway.js`:

- an **allowed tenant request reaches the fake backend**, and
- a **mismatched tenant is rejected before dispatch** (the fake backend records zero
  extra hits).

## How to run

```bash
node .prale-eval/demo/run-demo.mjs
```

Exit code is `0` when every check passes, `1` otherwise. The most focused validation is
that single command; it prints and writes the normalized result to
`.prale-eval/demo-output.json`.

## Artifacts

| Path | Role |
| --- | --- |
| `.prale-eval/demo/fixtures/fake-config.json` | Fake config fixture: the tenant registry (`tenant-a`, `tenant-b` with per-tenant tokens) and the gateway block (`rpc_path`). `port: null` is a placeholder the runner replaces with the ephemeral port the fake backend binds. |
| `.prale-eval/demo/fake-gateway.mjs` | Fake backend: an HTTP server that stands in for a per-tenant OpenClaw gateway endpoint. It appends one JSON line per accepted request to a hits file (with method, path, `Authorization`, attributed tenant, body) and replies `200 {ok:true, receivedBy:"fake-backend", tenantId}`. It binds `127.0.0.1:0` and prints `FAKE_GATEWAY_READY <port>`. |
| `.prale-eval/demo/run-demo.mjs` | Executable demo: starts the fake gateway, resolves the tenant target from the request context, gates dispatch, runs the scenarios, and emits the normalized result. |
| `.prale-eval/demo-output.json` | Normalized machine-readable operation result of the last run. |

## Contract exercised (grounded in the repository)

The demo replays the tenant-target contract of
`server/core/multi-tenant-gateway.js`:

- `getHttpTargetForCurrentRequest()` (lines 448–466) reads the request tenant from
  `getRequestTenant()` (`server/core/request-context.js`) and returns
  `{ baseUrl: "http://<tenant.host>:<tenant.port>",
     headers: { Authorization: "Bearer <tenant.token>" }, tenant }`.
  The demo's `resolveTenantTarget()` builds the same base URL and bearer header from the
  fixture registry, and `run-demo.mjs` imports the **real** `runWithRequestContext` /
  `getRequestTenant` symbols so the context binding is not re-implemented.
- `getHttpTargetForTenantId()` (lines 468–485) and `callGatewayForTenant()` (lines
  417–426) reject an unknown tenant with `Tenant <id> not found` **before**
  `ensureGatewayClient` / `ensureConnected` runs, so no request is dispatched.
- `getTenantForUser()` (lines 501–509) resolves a user's owning tenant, and
  `ensureConnected()` (lines 704–780) is the connection gate that runs only after a
  tenant target has been resolved.

The demo's dispatch gate (`authorizeAndDispatch`) applies the same boundary to the
credentials a request presents:

1. missing request-context tenant → `401 missing_tenant_context`, no dispatch;
2. context tenant not in the registry → `403 unknown_tenant` (mirrors
   `Tenant <id> not found`), no dispatch;
3. credential tenant ≠ context tenant → `403 tenant_mismatch`, no dispatch;
4. credential tenant == context tenant → `fetch` to that tenant's `baseUrl` with
   `Authorization: Bearer <token>`.

## Normalized operation result

`.prale-eval/demo-output.json` records:

- `allowed_tenant_reaches_backend: true`
- `mismatched_tenant_rejected_before_dispatch: true`
- `backend_hit_count: 1` (only the allowed request was ever sent)
- per-scenario `{status, reason, contextTenantId, credentialTenantId, dispatched, backend}`
- `checks` + `passed`

Sample run (port varies per run):

```json
{
  "allowed_tenant_reaches_backend": true,
  "mismatched_tenant_rejected_before_dispatch": true,
  "backend_hit_count": 1,
  "scenarios": {
    "allowed":        { "status": 200, "reason": "dispatched",      "contextTenantId": "tenant-a", "credentialTenantId": "tenant-a", "dispatched": true,  "backend": { "ok": true, "receivedBy": "fake-backend", "tenantId": "tenant-a" } },
    "mismatch":       { "status": 403, "reason": "tenant_mismatch", "contextTenantId": "tenant-a", "credentialTenantId": "tenant-b", "dispatched": false },
    "unknown_tenant": { "status": 403, "reason": "unknown_tenant",  "error": "Tenant tenant-ghost not found", "dispatched": false }
  },
  "passed": true
}
```

## Empirical result

`node .prale-eval/demo/run-demo.mjs` → exit `0`; the fake backend log contained exactly
one line, from the allowed `tenant-a` request (`Bearer fake-token-tenant-a`). The
mismatch (`tenant-a` context + `tenant-b` credential) and unknown-tenant
(`tenant-ghost`) scenarios were rejected in-process and produced **no** additional
backend hits, proving rejection happened before dispatch.

## Limitations

- The demo targets a local fake HTTP backend; it does not start Docker, tenant
  containers, or the real OpenClaw gateway. `server/core/multi-tenant-gateway.js`
  cannot be imported in this checkout because its transitive `../database.js` →
  `better-sqlite3` dependency and `node_modules` are absent, so the demo imports only
  the dependency-free `server/core/request-context.js` and replays the documented
  target contract. This is limited-strength substitute evidence, not the full suite.
- No dependency was installed and no repository source, task metadata, lockfile, or git
  configuration was modified.
