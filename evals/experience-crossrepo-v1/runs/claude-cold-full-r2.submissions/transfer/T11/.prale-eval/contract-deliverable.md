# Contract deliverable — header gate on `POST /api/v1/skill/*` (panel route, T11)

## Scope

Task mode: **contract**. The request is to contract *a different panel route* —
different from the previously contracted `POST /api/v1/task/list-with-agents`
aggregation route — that carries **missing or invalid required headers**, and to
verify the route (a) returns the *standard control envelope* and (b) **never
calls the downstream fake client**.

Contracted route: **`POST /api/v1/skill/*`** (Skill data-plane transparent
proxy, `MemoryPanel/src/panel/http/routes/skill/proxy.ts`). It is guarded by the
shared middleware `validatePanelMetaHeaders`
(`MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts`), the single
choke point for `x-tdai-service-id` / `x-tdai-user-key` enforcement in the panel.

## The contract (what must hold)

For every request to a `validatePanelMetaHeaders`-guarded route, the middleware
must short-circuit *before the handler runs* and return the standard control
envelope. On the skill route, the order is:

| Condition | HTTP | Envelope `message` | Downstream `skillKernel.invoke` |
|---|---|---|---|
| `x-tdai-service-id` absent | 400 | `MISSING_INSTANCE_ID` | **never called** |
| `x-tdai-service-id` blank/whitespace (`.trim()`) | 400 | `MISSING_INSTANCE_ID` | **never called** |
| instance id not in registry (`resolve` throws 400) | 400 | `INVALID_INSTANCE` | **never called** |
| `x-tdai-user-key` absent (non-`auth/verify` route) | 400 | `MISSING_USER_KEY` | **never called** |
| `x-tdai-user-key` blank/whitespace | 400 | `MISSING_USER_KEY` | **never called** |
| all headers valid | 200 | `ok` (code 0) | called exactly once |

The envelope is always the same shape (`controlEnvelope`, `http/envelope.ts`
lines 5–16):

```json
{ "code": 400, "message": "MISSING_INSTANCE_ID", "request_id": "<x-request-id>", "data": null }
```

`request_id` echoes the inbound `x-request-id` (set by `requestLogger`), and the
HTTP status is derived from `code` via `mapHttpStatusFromEnvelopeCode`.

Why a *different* route changes nothing structurally: the skill proxy reuses the
same middleware as the meta proxy and the task aggregation route, and its
`readAction` (`marker = '/skill/'`) returns `''` for skill paths, so
`omitUserKey === false` and the user-key requirement is enforced — the same
"never touch the kernel" guarantee applies to any guarded route.

## Executable demo

`MemoryPanel/tests/panel/skill-proxy-header-contract.test.ts` (vitest, node
environment per `MemoryPanel/vitest.config.ts` → `tests/**/*.test.ts`).

The demo builds a minimal Hono app that mounts the **real**
`registerSkillProxyRoutes` behind the **real** `requestLogger` and
`validatePanelMetaHeaders`, with a **real** `InstanceRegistry` holding one test
instance. The downstream clients are recording fakes:

- `fakeSkillKernel.invoke` — the downstream fake client for this route;
- `fakeMetaKernel.invoke` — asserted untouched on the skill path.

Six cases: five negative (each missing/invalid-header permutation above) that
assert the exact envelope + 400 + `invoke` never called, plus one positive
control where valid headers reach the handler and the fake is invoked exactly
once — proving the negative assertions are meaningful.

Run:

```bash
pnpm --dir MemoryPanel vitest run tests/panel/skill-proxy-header-contract.test.ts
```

## Normalized result

Each negative request yields exactly:

```
HTTP 400
{ code: 400, message: <MISSING_INSTANCE_ID|INVALID_INSTANCE|MISSING_USER_KEY>,
  request_id: <echoed x-request-id>, data: null }
```

and a downstream invocation count of `0` for both fake clients. The positive
control yields `HTTP 200` and a downstream invocation count of `1` for the skill
fake, `0` for the meta fake.

## Validation status / limitation

The workspace has **no installed dependencies** (`MemoryPanel/node_modules`
absent) and installing them is out of scope, so the vitest run could not be
executed here. As an available focused check, the test file was parsed with
`node --check` (Node 24 TypeScript type-stripping) and passed. Command, status
and full notes are recorded in `.prale-eval/result.json` → `validation`.

## Non-modification

No task metadata, hidden-oracle files, package locks, or git configuration were
modified. The only added artifacts are the test file above and the two files in
`.prale-eval/`.
