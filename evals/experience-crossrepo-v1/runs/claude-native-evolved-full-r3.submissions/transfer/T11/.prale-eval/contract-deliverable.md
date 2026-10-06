# Contract deliverable — panel header guard on a proxy route

Task: `T11` · repository: `tdam` · mode: `contract`

## What was contracted

**Route:** `POST /api/v1/skill/*` — the skill data-plane transparent proxy registered by
`registerSkillProxyRoutes` in `MemoryPanel/src/panel/http/routes/skill/proxy.ts`.

This is a *different* panel route from the `/api/v1/meta/*` proxy that shares the same guard:
`validatePanelMetaHeaders` derives the meta action by slicing after the hardcoded `/meta/`
marker (`readAction`, lines 24–29). A `/skill/*` path contains no `/meta/`, so the action is
`''`, the `auth/verify` exemption (`omitUserKey`) does not apply, and `x-tdai-user-key` is
unconditionally required. That makes it a clean subject for the contract.

## The contract

For a request to the guarded route with a **missing or invalid required header**, the route must:

1. return the **standard control envelope** `{ code, message, request_id, data }`, with
   `data: null` and `request_id` a string (defaults to `''` when no request id is set); and
2. **never call the downstream fake client** (the kernel client the route would otherwise proxy to).

Rejection matrix (HTTP status is derived from `code` by `mapHttpStatusFromEnvelopeCode`):

| Condition | HTTP | envelope `code` | `message` |
| --- | --- | --- | --- |
| `x-tdai-service-id` absent (or blank after trim) | 400 | 400 | `MISSING_INSTANCE_ID` |
| `x-tdai-service-id` present but not in the registry | 400 | 400 | `INVALID_INSTANCE` |
| instance valid, `x-tdai-user-key` absent (blank), non-`auth/verify` action | 400 | 400 | `MISSING_USER_KEY` |
| both headers valid | 200 | 0 (from downstream) | `ok` |

Why rejection implies "no downstream call": in
`validate-panel-headers.ts` every failure branch executes `return respondControlError(...)`
**before** `c.set('panelMeta', ...)` and `await next()`. The route handler — the only place that
reads `c.get('panelMeta')` and calls `deps.skillKernel.invoke(...)` — runs only after `next()`.
A rejected request therefore cannot reach the downstream client.

## Deliverables (executable)

### 1. Dependency-free runner — `MemoryPanel/tests/panel/contract-panel-header-guard.run.mjs`

Executes the **real** sources `src/panel/http/middleware/validate-panel-headers.ts` and
`src/panel/http/envelope.ts` (Node type-strips the TypeScript). Only two collaborators that are
unavailable without `node_modules` are stubbed, under `tests/panel/stubs/`:

- `hono-factory.mjs` — `createMiddleware` is a typed identity helper, so the stub returns the
  handler unchanged;
- `instance-registry.mjs` — needs `zod` and a TS parameter property; the stub re-declares
  `InstanceRegistry`/`InstanceRegistryError` so the middleware's `instanceof` branch is real.

`stubs/loader.mjs` is a Node module-customization hook that maps the bare/stubbed specifiers and
rewrites repository-relative `./x.js` imports to their `./x.ts` sources; `stubs/register.mjs`
installs it.

The "route" is modelled as the middleware composed with a handler that records calls to a fake
kernel client. Both the response envelope and `downstream.calls.length === 0` are asserted.

```sh
cd MemoryPanel
node --import ./tests/panel/stubs/register.mjs tests/panel/contract-panel-header-guard.run.mjs
# -> contract-panel-header-guard: PASS (58 checks)
```

Covered cases: missing / invalid / blank service-id; missing user-key on `/skill/*`; a valid-header
control that *does* reach the fake client (proving the negative assertion is meaningful); the same
missing-user-key rejection on `/api/v1/meta/user/list`; the `/meta/auth/verify` exemption; the
registry error type; and static route wiring (middleware registered before the downstream call in
both `skill/proxy.ts` and `meta/proxy.ts`).

### 2. Canonical vitest contract — `MemoryPanel/tests/panel/contract-panel-header-guard.test.ts`

Route-level, using the real `Hono` app and `registerSkillProxyRoutes` /
`registerMetaProxyRoutes`, asserting status, envelope shape and `expect(skillKernel.invoke).not
.toHaveBeenCalled()`. This is what `npm test` (glob `tests/**/*.test.ts`, `vitest.config.ts`)
runs once dependencies are installed.

## Validation status

- **Ran:** the dependency-free runner — **PASS (58/58 checks)** on Node v24.14.0.
- **Not run:** the vitest contract and `tsc --noEmit`, because `node_modules` is absent in this
  environment (`hono`, `zod`, `vitest`, `tsx` all unavailable) and dependency installation is out
  of scope. The vitest file was syntax-verified via `node:module` `stripTypeScriptTypes`.

## Files touched

- `MemoryPanel/tests/panel/contract-panel-header-guard.run.mjs` (new, executable)
- `MemoryPanel/tests/panel/contract-panel-header-guard.test.ts` (new, canonical vitest)
- `MemoryPanel/tests/panel/stubs/loader.mjs` (new)
- `MemoryPanel/tests/panel/stubs/register.mjs` (new)
- `MemoryPanel/tests/panel/stubs/hono-factory.mjs` (new)
- `MemoryPanel/tests/panel/stubs/instance-registry.mjs` (new)
- `.prale-eval/result.json` (new)
- `.prale-eval/contract-deliverable.md` (new)

No task metadata, hidden-oracle files, package locks or git configuration were modified.
