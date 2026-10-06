# T13 — Panel header-contract demo (`tdam` / MemoryPanel)

## Scope

Contract **a different panel route** — `POST /api/v1/task/list-with-agents`
(Panel-layer aggregate route from `registerTaskRoutes`, distinct from the generic
`/meta/*` transparent proxy and the `/skill/*` proxy) — behind
`validatePanelMetaHeaders`, and pin down its behaviour when the required
instance/user headers are **missing, blank, or invalid**:

1. it returns the **standard control envelope** `{ code, message, request_id, data }`
   with the correct HTTP status, and
2. it **never calls the downstream (fake) kernel client**.

No production source was modified. The contract is expressed as an executable
test plus a dependency-free static assertion.

## Contract (normative)

Required request headers (single source of truth:
`MemoryPanel/src/panel/kernel/headers.ts`):

| Header | Constant | Required |
| --- | --- | --- |
| `x-tdai-service-id` | `META_HEADER_SERVICE_ID` | always |
| `x-tdai-user-key` | `META_HEADER_USER_KEY` | all actions except `meta/auth/verify` |

Middleware `validatePanelMetaHeaders(deps)` (`MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts`):

| Condition | Envelope `code` / `message` | HTTP | `data` | Downstream call |
| --- | --- | --- | --- | --- |
| `x-tdai-service-id` absent or blank | `400` / `MISSING_INSTANCE_ID` | 400 | `null` | **none** |
| `x-tdai-service-id` not in registry | `400` / `INVALID_INSTANCE` | 400 | `null` | **none** |
| `x-tdai-user-key` absent or blank (action ≠ `auth/verify`) | `400` / `MISSING_USER_KEY` | 400 | `null` | **none** |
| headers valid | handler result (e.g. `code:0`) passed through | mapped from envelope code | handler data | invoked once |

Envelope shape and status mapping: `MemoryPanel/src/panel/http/envelope.ts`
(`controlEnvelope` / `respondControlError`) and
`MemoryPanel/src/panel/kernel/envelope.ts` (`mapHttpStatusFromEnvelopeCode`:
400–599 → the code itself). `request_id` is taken from `c.get('reqId')`
and is always a string (empty string when no request logger ran).

Guarantee mechanism: all three rejection branches `return respondControlError(...)`
**before** `c.set('panelMeta', ...)` and `await next()`, so the route handler —
and therefore the downstream kernel client — is unreachable on rejection.

## Executable demo

`MemoryPanel/tests/panel/validate-panel-headers.contract.test.ts` (vitest, repo
canonical runner `pnpm test`, includes `tests/**/*.test.ts`).

Harness: a real `Hono` app mounting the real `registerTaskRoutes` over a real
`InstanceRegistry` seeded with one instance (`local`), plus a **fake downstream
client** — `metaKernel.invoke = vi.fn(async () => OK_ENVELOPE)`.

Cases:

| # | Request headers | Expected |
| --- | --- | --- |
| 1 | only `x-tdai-user-key` | 400 / `MISSING_INSTANCE_ID`, envelope shape, `invoke` not called |
| 2 | `x-tdai-service-id: no-such-instance` + user key | 400 / `INVALID_INSTANCE`, `invoke` not called |
| 3 | only `x-tdai-service-id: local` | 400 / `MISSING_USER_KEY`, `invoke` not called |
| 4 | both headers whitespace-only | 400 / `MISSING_INSTANCE_ID`, `invoke` not called |
| 5 | positive control: both valid | 200, downstream envelope passed through, `invoke` called once with `task/list` |

Case 5 is the guard against a vacuous negative test: it proves the fake client
*is* reachable when headers are valid, so cases 1–4 genuinely demonstrate that
rejection happens **before** any downstream invocation.

## Validation actually run

Dependencies `hono`, `zod` and `vitest` are **not installed** in this checkout
and the task forbids installing them. Per doctrine ("校验依赖不可用时在产物中记录限制而非安装，以语法解析与静态断言作受限强度的替代证据"),
the runtime test above could not be executed here; instead the runnable
dependency-free validator `.prale-eval/validate-panel-headers-contract.mjs`
performs 14 static assertions over the real sources (header constants, the three
guard branches, the ordering of `await next()` relative to the guards, the
envelope shape/status mapping, and the route mounting the middleware).

Result: **14/14 checks passed** (`node .prale-eval/validate-panel-headers-contract.mjs`, exit 0).

Limitation: static assertions confirm the guarded source text, **not** executed
runtime behaviour. Run `pnpm install && pnpm test` in `MemoryPanel/` to obtain
the runtime ("strong") evidence for this contract.
