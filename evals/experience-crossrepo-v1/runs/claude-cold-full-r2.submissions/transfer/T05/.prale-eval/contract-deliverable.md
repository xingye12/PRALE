# T05 — MemoryPanel config precedence contract

**Repository:** `tdam` · **Mode:** `contract` · **Area:** `MemoryPanel` instance/panel configuration

## Contract

MemoryPanel resolves instance/panel configuration through three layers. Where
the layers conflict, the higher layer wins:

| # | Layer | Source | Example |
|---|-------|--------|---------|
| 1 | **Explicit request input** | per-request `x-tdai-service-id` header / body `service_id` → `InstanceRegistry.resolve()`; injected as the knowledge `serviceId` | request asks for `inst-b` → `inst-b`'s endpoint is used |
| 2 | **Panel config** | `process.env` read by `loadPanelConfig()` (populated by `dotenv`); entry fields from `metadata-instances.json` | `PORT=9000` beats the default `8123` |
| 3 | **Default** | hard-coded fallback literals in `panel-config.ts`; `proxy_endpoint ?? gateway_endpoint` | no `PORT` → `8123`; no `proxy_endpoint` → `gateway_endpoint` |

Conflict tie-breaks:

- **Request vs config:** the request selects *which* configured entry applies.
  An instance id absent from config is **rejected** (`InstanceRegistryError`,
  code `400`, `INVALID_INSTANCE`) — it never falls back to a default instance.
- **Config vs default:** a *well-formed* env value wins. A present-but-degenerate
  value does **not** win — `env()` falls back via `??`, `envInt()` rejects
  `undefined`/`''`/non-finite, `envBool()` accepts only `'true'`/`'1'`,
  `log.level` accepts only the four known levels.
- **Config vs default (instances):** an explicitly configured `proxy_endpoint`
  wins; an absent one is omitted so the consumer's `??` yields
  `gateway_endpoint`. `api_key` never appears in the public listing.

## Executable demo

`.prale-eval/precedence-demo.mjs` imports and calls the **real** repo modules
(`MemoryPanel/src/panel/config/panel-config.ts`,
`.../instance-registry.ts`) and asserts all three layers, including one
deliberate three-way conflict per layer boundary.

```
node --experimental-transform-types --import ./.prale-eval/register-stubs.mjs ./.prale-eval/precedence-demo.mjs
```

Result: **23 passed, 0 failed** (exit 0).

| Group | Assertions | Proves |
|-------|-----------|--------|
| layer 3 defaults | 7 | fallback literals used when no config |
| layer 2 config > default | 6 | env wins over default; degenerate env falls back |
| layer 1 request > config | 10 | request selects instance; unknown id rejected; `proxy_endpoint ?? gateway_endpoint`; secret not leaked |

### Environment stubs (load-time only)

`node_modules` is absent and dependency installation is disallowed, so
`.prale-eval/stub-hooks.mjs` intercepts only the two bare specifiers the config
modules import — `dotenv` (no-op `config()`) and `zod` (chainable schema stubs).
They are consulted at module-load time only; the resolution logic under test is
the repository's own code. `--experimental-transform-types` is required because
`instance-registry.ts` uses a constructor parameter property, which Node's
strip-only type stripping rejects.

## In-repo test

The same contract is expressed as a Vitest suite for CI (where dependencies are
installed), using `vi.stubEnv` to force config-vs-default conflicts:

```
MemoryPanel/tests/panel/config/panel-config-precedence.test.ts
# run: cd MemoryPanel && npm test
```

This suite could not be executed in this workspace — no `node_modules`, and
dependency installation is disallowed. The demo above is the executed evidence.

## Result

JSON contract at `.prale-eval/result.json` (`task_id` `T05`, `repository`
`tdam`, `mode` `contract`, with `evidence`, `claims`, `conclusion`,
`validation`). Verdict: precedence resolves **explicit request input > panel
config > default**, and degenerate/unknown higher-layer input is rejected rather
than silently degrading to the default.
