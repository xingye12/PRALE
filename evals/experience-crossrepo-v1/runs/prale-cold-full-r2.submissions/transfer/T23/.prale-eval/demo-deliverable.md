# T23 — WattClaw cross-tenant dispatch demo (`mode: demo`, `repository: wattclaw`)

## What this proves

Using only **local fake gateway/config fixtures** and two **local fake gateway backends**, the demo shows:

1. **Allowed path** — a request from a user bound to `tenant-a` is routed to the `tenant-a` fake backend,
   carrying that tenant's own host/port and `Authorization: Bearer demo-token-tenant-a`, and the backend
   answers `200`.
2. **Mismatch path** — the same user asking for `tenant-b` is **rejected with `403` before dispatch**:
   no routing target is built, the dispatch-attempt counter does not advance, and **neither** fake backend
   receives a single byte.
3. **Symmetric allowed path** — a user bound to `tenant-b` reaches the `tenant-b` backend with
   `Bearer demo-token-tenant-b`, confirming the routing is tenant-scoped in both directions.

Run it with:

```bash
node demo/tenant-routing-demo.mjs
# exit code 0, prints a JSON report followed by:
# DEMO OK: allowed tenant request reached its fake backend; mismatched tenant was rejected (403) before dispatch.
```

Everything runs offline on Node's standard library: no npm install, no Docker, no OpenClaw container,
no sockets beyond ephemeral `127.0.0.1` ports.

## Files

| Artifact | Purpose |
| --- | --- |
| `demo/tenant-routing-demo.mjs` | Executable demo: fake backends, fake request-context, routing helpers, guard, assertions |
| `demo/fixtures/gateway-config.json` | Fake gateway/config fixture: tenants (host/port/token), users, user→tenant assignments |
| `demo/fixtures/requests.json` | Declarative requests + expected normalized operation results |
| `.prale-eval/result.json` | Machine-readable evidence, claims, conclusion, validation record |
| `.prale-eval/demo-deliverable.md` | This document |

## The contract, and where it comes from

The demo is a faithful, dependency-free exercise of the repository's own multi-tenant routing contract:

| Behaviour | Production source (repository-relative, inclusive lines) |
| --- | --- |
| A request carries the tenant it was authorized against | `server/core/request-context.js:5-7` `runWithRequestContext`, `server/core/request-context.js:17-19` `getRequestTenant` |
| The authenticated user's single tenant is resolved before routing | `server/core/auth.js:25-36` `authMiddleware`; `server/core/multi-tenant-gateway.js:501-509` `getTenantForUser` |
| The dispatch target comes **only** from the context tenant | `server/core/multi-tenant-gateway.js:448-466` `getHttpTargetForCurrentRequest` (`baseUrl = http://${tenant.host}:${tenant.port}`, `Authorization: Bearer ${tenant.token}`) |
| All RPCs inside a request use the request-scoped tenant gateway | `server/core/multi-tenant-gateway.js:130-152` `MultiTenantGatewayProxy` (`.call` at 148-151), `397-411` `getGatewayForCurrentRequest` |
| Tenant records are normalized into the `{id, token, host, port, …}` shape the router reads | `server/core/multi-tenant-gateway.js:2052-2065` `normalizeTenant` |
| The HTTP layer consumes that per-tenant target | `server/core/gateway-client.js:14-30` `_buildGatewayHttpOptions` |
| Existing precedent for "mismatched tenant ⇒ do not proceed" | `server/index.js:390-398` `broadcastWattClawProjectsChanged` (`if (!client.isAdmin && tenantId && client.tenantId !== tenantId) continue`) |

The repository already refuses to deliver to a non-matching tenant in the SSE fan-out path; the demo
lifts that exact predicate ahead of dispatch so the rejection happens **before** any target is built.

### Fixture semantics

`demo/fixtures/gateway-config.json` uses the same field names as a provisioned tenant record
(`id`, `containerName`, `host`, `port`, `token`, `dataSource`, `maxUsers`, `status`) so it is structurally
interchangeable with the output of `normalizeTenant`. `port: 0` means "bind an ephemeral fake backend on
`127.0.0.1` at demo runtime and publish the resolved port", which mirrors a real tenant getting a concrete
host/port.

```
users:       demo-alice -> tenant-a, demo-bob -> tenant-b
backends:    tenant-a (token demo-token-tenant-a), tenant-b (token demo-token-tenant-b)
```

## Normalized operation results (observed)

| Case | Caller | Requested tenant | Status | Dispatched | Target tenant | Authorization | Backend traffic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `allowed-tenant-a` | demo-alice | tenant-a | `200` | yes | tenant-a | `Bearer demo-token-tenant-a` | tenant-a: +1 request (`sessions.list`), token valid |
| `mismatched-tenant-b` | demo-alice | tenant-b | `403` | **no** | — (never built) | — | none; dispatch counter unchanged (1); no backend grew |
| `allowed-tenant-b` | demo-bob | tenant-b | `200` | yes | tenant-b | `Bearer demo-token-tenant-b` | tenant-b: +1 request (`sessions.list`), token valid |

Final invariant asserted by the harness: `totalDispatchAttempts = 2` for 3 inbound cases (one rejected
pre-dispatch), and both fake backends report `allTokensValid: true`.

Rejection error text:

```
tenant mismatch: user demo-alice is bound to tenant-a but requested tenant-b
```

## How the "before dispatch" claim is checked, not just stated

`handleRequest` (lines 137–193) evaluates the mismatch guard while still inside the request context:

```js
if (!tenantMatches(routeTenantId, contextTenant.id)) {
  return { status: 403, dispatched: false,
           dispatchAttemptsBefore, dispatchAttemptsAfter: env.dispatchAttempts, ... }
}
const target = getHttpTargetForCurrentRequest()   // built only for the bound tenant
env.dispatchAttempts += 1                         // incremented only after the guard passes
```

The harness then asserts, for the mismatch case, that `dispatchAttemptsAfter === dispatchAttemptsBefore`
and that no fake backend's recorded request count grew (`noNewBackendRequests` expectation in
`demo/fixtures/requests.json`). Each fake backend additionally records the `Authorization` header it saw
and reports whether it matched its own token, so the allowed cases also prove per-tenant credential use.

## Validation

* **Command:** `node demo/tenant-routing-demo.mjs`
* **Status:** `pass` (exit code 0, Node v24.14.0)
* **Also verified by hand:** every symbol cited in `.prale-eval/result.json` appears inside its stated
  inclusive line range in the referenced repository file.

**Recorded limitation:** this workspace has no `node_modules` (`better-sqlite3`, `vitest` and the other
devDependencies are absent) and dependencies must not be installed, so the repository suites
(`npm run test:server`) could not be executed. Consequently the demo deliberately does **not** import
`server/core/multi-tenant-gateway.js` directly — that module transitively imports
`server/database.js` → `better-sqlite3`. Instead the demo reproduces the cited routing helpers with
identical semantics and the same fixture record shape, so the behaviour is executable and checkable
offline today. No optional dependency was installed or downloaded.

## Non-goals / what is intentionally untouched

* No changes to `TASK.md`, hidden-oracle files, `package.json`/`package-lock.json`, or git configuration.
* No real gateway, Docker socket, database, or network service is contacted.
* The demo is additive: it only adds `demo/` and `.prale-eval/` artifacts.
