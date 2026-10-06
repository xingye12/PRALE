# T05 — MemoryPanel instance/panel configuration precedence contract

- Repository: `tdam` · Mode: `contract` · Task: `T05`
- Subject: **precedence test for instance/panel configuration where explicit request input, config and default conflict**
- Status: **pass** — 24/24 executable precedence assertions (`node .prale-eval/precedence-demo.mjs`)

## 1. The contract

MemoryPanel resolves instance/panel configuration in exactly three layers. When they disagree, the
higher layer wins **per field**; no layer ever silently borrows from a lower one where the code
chooses to fail closed.

| # | Layer | Where it lives | Example |
|---|-------|----------------|---------|
| 1 | **Explicit request input** | `x-tdai-service-id` header (`validate-panel-headers.ts`) and the process environment *before* `loadPanelConfig()` runs | `x-tdai-service-id: proxy-split`, `HOST=10.9.9.9` |
| 2 | **Config** | env values already present at boot; instance registry entries parsed from `METADATA_INSTANCES_CONFIG` | `{"id":"proxy-split","gateway_endpoint":"http://127.0.0.1:8420","proxy_endpoint":"http://127.0.0.1:8096","api_key":"…"}` |
| 3 | **Built-in default** | fallback literals in `env()/envInt()/envBool()`, the `info`/`json` log whitelist, and the client-side `proxy_endpoint ?? gateway_endpoint` fallback | `HOST → 0.0.0.0`, `PORT → 8123`, `KNOWLEDGE_SERVICE_URL → http://127.0.0.1:8421`, `METADATA_INSTANCES_CONFIG → ./config/metadata-instances.json` |

The rules the test pins down (all in `MemoryPanel/src/panel/config/panel-config.ts`,
`MemoryPanel/src/panel/config/instance-registry.ts`,
`MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts`):

1. **Valid explicit input always beats config and default** — `HOST`, `PORT`,
   `METADATA_INSTANCES_CONFIG`, `LOG_LEVEL`, and even an explicit `false` for
   `KNOWLEDGE_LLM_BINDING_SYNC` (default `true`).
2. **A blank explicit value is not an explicit value for int/bool/enum fields** —
   `PORT=''` → `8123`, `KNOWLEDGE_LLM_BINDING_SYNC=''` → `true`, `LOG_LEVEL='verbose'` → `info`:
   the field degrades to the default instead of producing an invalid configuration.
3. **A blank explicit value *is* explicit for plain string fields** — `env()` uses `??`, not `||`,
   so `KNOWLEDGE_SERVICE_URL=''` produces `baseUrl: ''` rather than the default. This is the most
   surprising conflict in the file and is why the contract is documented per type.
4. **Request input selects, config supplies** — the header is trimmed, must be non-empty
   (`400 MISSING_INSTANCE_ID`), and must exist in the registry (`400 INVALID_INSTANCE` *even though
   a `default` entry exists*). For a configured id, `gatewayEndpoint`/`gatewayApiKey` come from the
   config entry.
5. **Only one field has a legitimate config → default fallback** — `proxy_endpoint`, which
   `listPublic()` omits when unset so clients fall back to `gateway_endpoint`; `api_key` is never
   published, so the default layer can never resurrect a credential.

## 2. Deliverables

| Artifact | Kind | Purpose |
|---|---|---|
| `.prale-eval/precedence-demo.mjs` | executable demo | Dependency-free runner that loads the **real** repository sources and asserts the precedence matrix (A0–A7 panel layers, B1–B5 instance layers, C1–C5 request-header middleware, `D:*` citation integrity). Exit code 0 = contract holds. |
| `.prale-eval/precedence-demo-output.json` | normalized operation result | Machine-readable result of the demo: `schema`, `precedence_order`, checks with `input`/`expected`/`actual`/`pass`, `summary` and the normalized `PanelConfig` produced from conflicting input. |
| `MemoryPanel/tests/panel/panel-config-precedence.test.ts` | vitest test | The same contract in the repository's own test layout (`vitest.config.ts` includes `tests/**/*.test.ts`), using real `hono` + `InstanceRegistry` + `loadPanelConfig` imports. |
| `.prale-eval/result.json` | evidence contract | Required task record: citations, claims, conclusion, validation. |

No repository source file was modified; the test and the demo are additive.

## 3. How to run

```bash
# from the workspace root — no dependencies required
node .prale-eval/precedence-demo.mjs
```

Observed output (tail):

```
PASS  C1         {"header":"  proxy-split  "}
PASS  C2         {"absent":"no x-tdai-service-id","blank":"\"   \""}
PASS  C3         {"header":"does-not-exist"}
PASS  C4         {"action":"agent/list"}
PASS  C5         {"action":"auth/verify"}
PASS  D:loadPanelConfig ... PASS  D:listPublic

24/24 precedence checks passed
normalized result written to .prale-eval/precedence-demo-output.json
```

The idiomatic vitest entry point is `pnpm --dir MemoryPanel test`
(`MemoryPanel/tests/panel/panel-config-precedence.test.ts`).

## 4. Normalized operation result

Conflicting input fed to `loadPanelConfig()`
(`HOST=10.9.9.9`, `PORT=''`, `METADATA_INSTANCES_CONFIG='./config/instances.alt.json'`,
`LOG_LEVEL='trace'`, `KNOWLEDGE_SERVICE_URL=''`, `KNOWLEDGE_LLM_BINDING_SYNC='false'`) normalizes to:

```json
{
  "server": { "host": "10.9.9.9", "port": 8123 },
  "metadataInstancesConfig": "./config/instances.alt.json",
  "metadataRemoteTimeoutMs": 15000,
  "ui": { "distDir": "./web/dist" },
  "log": { "level": "info", "format": "json" },
  "knowledge": { "baseUrl": "", "authToken": "", "timeoutMs": 15000 },
  "knowledgeLlmBinding": { "sync": false, "proxyBaseUrl": "http://127.0.0.1:8096" },
  "agentTemplateDir": "./data/agent-templates"
}
```

Reading the conflicts: `host` took the explicit value; `port` and `log.level` fell back to their
defaults because the explicit input was blank / out of enum; `metadataInstancesConfig` took the
explicit config-path; `knowledge.baseUrl` kept the explicit empty string (`??` semantics);
`sync` took the explicit `false` over the default `true`.

Instance layer with `x-tdai-service-id: proxy-split` normalizes to
`gatewayEndpoint: http://127.0.0.1:8420`, `gatewayApiKey: cfg-key-proxy`,
`proxy_endpoint: http://127.0.0.1:8096` (config beats the `gateway_endpoint` default), while
`x-tdai-service-id: does-not-exist` normalizes to `400 INVALID_INSTANCE` — no fallback to the
configured `default` instance.

## 5. Validation

| Check | Command | Result |
|---|---|---|
| Precedence matrix + citations | `node .prale-eval/precedence-demo.mjs` | **pass** — 24/24 checks, exit 0 |
| Evidence line ranges | built into the demo (`D:*` checks) | **pass** — every cited symbol is present in its cited range |
| Syntax of the vitest test | parsed with `node:module.stripTypeScriptTypes` | **pass** (parse-only) |
| `pnpm --dir MemoryPanel test` / `typecheck` | not run | **blocked** — no `node_modules`, dependency installation out of scope |

Recorded limitation: because `dotenv`, `zod` and `hono` are not installed, the demo compiles the
repository TypeScript with Node's built-in type stripper and substitutes inert shims for those three
third-party imports (`loadDotenv` no-op, an unused chainable proxy for the `z` schema declarations,
`createMiddleware = (handler) => handler`) plus a three-method fake Hono context. The precedence
logic executed is the repository's own; what is *not* exercised is real Hono routing and real
`zod` validation inside `InstanceRegistry.load()`. The vitest test in `MemoryPanel/tests/panel/`
covers the same contract against the real dependencies once they are installed.
