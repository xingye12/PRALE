# T05 — MemoryPanel instance/panel configuration precedence contract

**Task:** `T05` · **Repository:** `tdam` · **Mode:** `contract`

## Contract

When the same logical setting is supplied by more than one source, MemoryPanel
resolves it in this strictly ordered precedence:

```
explicit request input   >   config   >   default
```

| Tier | MemoryPanel surface | Where |
| --- | --- | --- |
| **explicit request input** | request header `x-tdai-service-id` (`META_HEADER_SERVICE_ID`) selecting the instance; request-scoped values that reach config consumers | `kernel/headers.ts`, `http/middleware/validate-panel-headers.ts` → `InstanceRegistry.resolve` |
| **config** | env-derived panel config (`loadPanelConfig`), and each instance entry from `metadata-instances.json` (e.g. `proxy_endpoint`) | `config/panel-config.ts`, `config/instance-registry.ts` |
| **default** | hardcoded literals in `loadPanelConfig` (port `8123`, timeout `15_000`, `'info'`, `'json'`, `http://127.0.0.1:8421`, `http://127.0.0.1:8096`, `./data/agent-templates`) and the `gateway_endpoint` fallback for an absent `proxy_endpoint` | `config/panel-config.ts`, `config/instance-registry.ts` |

Invariants the test pins:

1. **Config beats default.** `loadPanelConfig()` returns the configured
   `process.env` value whenever it is supplied, otherwise the literal default.
2. **Absent/invalid config falls to default.** `envInt`/`envBool` treat
   `undefined` and `''` as unset and reject non-finite input; `LOG_LEVEL` /
   `LOG_FORMAT` are domain-guarded, so `''`, `'verbose'`, `'yaml'`, or
   `'not-a-number'` resolve to the default tier rather than leaking through.
3. **Explicit input is live.** `loadPanelConfig()` re-reads `process.env` on
   every call (no memoization); a later explicit value wins over an earlier one.
4. **Request input strictly outranks defaults.** An unmatched
   `x-tdai-service-id` throws `InstanceRegistryError(400, 'INVALID_INSTANCE')`
   — it is never silently replaced by a configured/default instance.
5. **Instance config beats the endpoint default.** `listPublic()` emits
   `proxy_endpoint` only when configured; an absent field is omitted (not set to
   `undefined`) so the consumer's `?? gateway_endpoint` default applies.

## Executable demo / tests

### 1. Repo-native test (the requested precedence test)

`MemoryPanel/tests/panel/config-precedence.test.ts` — vitest, matched by
`MemoryPanel/vitest.config.ts` (`tests/**/*.test.ts`). 12 assertions across two
suites:

- `panel config precedence (config > default)` — 6 tests
- `instance config precedence (request input > instance config > default)` — 6 tests

Run in a normal checkout (deps installed):

```sh
cd MemoryPanel && npx vitest run tests/panel/config-precedence.test.ts
```

### 2. Dependency-free executable demo (offline normalization)

The workspace has **no installed `node_modules`**, and the task forbids
installing dependencies, so the same assertions were also executed offline
against the unmodified production modules:

```sh
# run the vitest test file itself, with import-safe shims for dotenv/zod/vitest
node --experimental-transform-types \
  --import ./.prale-eval/register-loader.mjs \
  ./MemoryPanel/tests/panel/config-precedence.test.ts

# standalone mirror of the same assertions (also imports the real modules)
node --experimental-transform-types \
  --import ./.prale-eval/register-loader.mjs \
  ./.prale-eval/config-precedence-demo.mjs
```

Supporting offline harness (no production source touched):

| File | Role |
| --- | --- |
| `.prale-eval/register-loader.mjs` | registers the resolver hook |
| `.prale-eval/deps-loader.mjs` | maps `dotenv`/`zod`/`vitest` to shims; maps NodeNext `.js` specifiers to sibling `.ts` sources |
| `.prale-eval/shims/dotenv.mjs` | import-safe `config()` no-op (demo sets `process.env` directly) |
| `.prale-eval/shims/zod.mjs` | chainable schema stand-in so `instance-registry.ts` imports cleanly |
| `.prale-eval/shims/vitest.mjs` | minimal `describe`/`it`/`beforeEach`/`afterEach`/`expect` |
| `.prale-eval/config-precedence-demo.mjs` | self-contained runnable demo + mini runner |

## Normalized operation result

| Command | Result |
| --- | --- |
| `node --experimental-transform-types --import ./.prale-eval/register-loader.mjs ./MemoryPanel/tests/panel/config-precedence.test.ts` | **12 passed, 0 failed** |
| `node --experimental-transform-types --import ./.prale-eval/register-loader.mjs ./.prale-eval/config-precedence-demo.mjs` | **11 passed, 0 failed** |
| `npx vitest run tests/panel/config-precedence.test.ts` (project runner) | not run — vitest not installed in this workspace (dependency unavailable) |

The offline runs import the real `MemoryPanel/src/panel/config/panel-config.ts`,
`.../instance-registry.ts`, and `.../kernel/headers.ts`; only the uninstalled
third-party packages are stubbed. No production source, package lock, task
metadata, hidden-oracle file, or git configuration was modified.

## Cited evidence

- `MemoryPanel/src/panel/config/panel-config.ts`
  - `env` L6–8, `envInt` L10–15, `envBool` L37–41
  - `PanelConfig` L17–35, `loadPanelConfig` L43–69
- Supporting: `MemoryPanel/src/panel/config/instance-registry.ts`
  (`InstanceRegistry.resolve` L96–102, `listPublic` L104–112),
  `MemoryPanel/src/panel/kernel/headers.ts` (`META_HEADER_SERVICE_ID` L5)
