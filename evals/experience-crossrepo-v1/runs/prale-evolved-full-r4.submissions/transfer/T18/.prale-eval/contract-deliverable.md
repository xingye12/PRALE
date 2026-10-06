# Contract deliverable — instance/panel config precedence (T18)

- **task_id:** `T18`
- **repository:** `tdam`
- **mode:** `contract`
- **Request:** Evaluate in MemoryPanel — construct a precedence test for instance/panel
  configuration where explicit request input, config and default conflict.

## 1. The operation under contract

MemoryPanel resolves its instance/panel configuration in exactly one place:

`MemoryPanel/src/panel/config/panel-config.ts` → `loadPanelConfig()`.

Every key is produced from three sources that can disagree for the same key:

| Priority | Source | Layer in the code | Why |
|---|---|---|---|
| 1 (highest) | **explicit request input** | a value already present in `process.env` when the panel starts | most specific, closest to the caller |
| 2 | **config** | the deployment `.env` file, loaded by `dotenv.config()` at module init (`override:false`) | project/deployment layer |
| 3 (lowest) | **default** | the hard-coded fallback literal passed to `env` / `envInt` / `envBool` inside `loadPanelConfig()` | built-in baseline |

The `dotenv` default `override:false` is what makes layer 1 beat layer 2: config
values are written into `process.env` **only for keys that are not already present**.
`loadPanelConfig()` is then called and reads the merged environment.

This is the same layering the doctrine describes (*explicit CLI override > project >
user > default*), applied per key.

### Conflict semantics (verified per resolver, not extrapolated)

| Resolver | Key absent | Key present, legal | Key present, illegal |
|---|---|---|---|
| `env(key, fallback)` (L6–8) | fallback (default) | explicit value wins — **including the empty string** (`??`) | n/a |
| `envInt(key, fallback)` (L10–15) | fallback | finite `Number` wins | **fallback (default)** — an illegal explicit value degrades to the default and never leaks to the `.env` value |
| `envBool(key, fallback)` (L37–41) | fallback | `'true'` / `'1'` → `true` | **`false`** — strict `raw === 'true' \|\| raw === '1'`, *not* the fallback |

So `envInt` and `envBool` deliberately differ: `envInt` is lenient (illegal → default),
`envBool` is strict (non-canonical → `false`). The test asserts each on its own path.

### Instance-config hand-off

`metadataInstancesConfig` (default `./config/metadata-instances.json`, L51) is resolved by
the same chain and is the path `buildPanelDeps` hands to `InstanceRegistry.load`
(`MemoryPanel/src/panel/panel-deps.ts:37`). The precedence test therefore covers the
*instance* configuration entry point as well as the panel configuration.

## 2. Executable precedence test (runs here, no dependencies)

**`.prale-eval/harness/precedence-runner.mjs`** imports and executes the **real**
`panel-config.ts` — not a re-implementation. Node 24's TypeScript type-stripping runs the
`.ts` source directly; a small module-resolution hook redirects only the bare specifier
`dotenv` to `.prale-eval/harness/dotenv-stub.mjs`, a faithful `override:false` stand-in.
This was necessary because the checkout has no `node_modules`, and installing dependencies
is out of scope. **No source file is modified.**

```
node --import ./.prale-eval/harness/register.mjs ./.prale-eval/harness/precedence-runner.mjs
```

Each scenario writes its own `.env` (the *config* layer), seeds explicit `process.env`
values (the *explicit request input* layer), imports the module fresh, and asserts the
resolved `PanelConfig`.

| # | Scenario | Excerpt of the conflict | Expected |
|---|---|---|---|
| A | all three conflict | explicit `PORT=9999` / `.env PORT=8000` / default `8123` | `9999` |
| A | all three conflict | explicit `KNOWLEDGE_SERVICE_URL` / `.env` / default | explicit |
| A | config vs default | `.env TDAI_AGENT_TEMPLATE_DIR=/from-env-file` | config |
| B | no explicit, config present | `.env PORT=8000`, `KNOWLEDGE_TIMEOUT_MS=2500`, `…SYNC=false` | config wins over defaults |
| C | nothing set | empty `.env`, no explicit input | every key = default |
| D | explicit illegal numeric + config present | explicit `PORT=not-a-port`, `.env PORT=8000` | **default `8123`** |
| E | explicit empty numeric + config present | explicit `PORT=''`, `.env PORT=8000` | **default `8123`** |
| F | invalid/valid enum | explicit `LOG_LEVEL=verbose` (`.env warn`), `LOG_FORMAT=pretty` | `info`, `pretty` |
| G | explicit empty string key | explicit `UI_DIST_DIR=''`, `.env` set | `''` (not the default) |
| H | `envBool` canonical | explicit `…SYNC='1'` | `true` |
| H2 | `envBool` explicit false | explicit `…SYNC='false'` | `false` (beats default `true`) |
| H3 | `envBool` non-canonical | explicit `…SYNC='yes'` | **`false`**, not fallback `true` |
| I | instance-registry path | explicit `METADATA_INSTANCES_CONFIG=/explicit/…` vs `.env /config/…` | explicit |
| I2 | instance-registry path | only `.env` set | config |

**Observed result:** `SUMMARY {"target":"…/MemoryPanel/src/panel/config/panel-config.ts",
"sha256":"ab8536456b9d1aeb","passed":12,"failed":0,"total":12}` — exit `0`.

## 3. Canonical in-repo test

`MemoryPanel/tests/panel/panel-config.precedence.test.ts` is the same precedence test in
vitest form, matching the repository's configured include (`tests/**/*.test.ts` in
`MemoryPanel/vitest.config.ts`). It mocks `dotenv` with `override:false` semantics, seeds
the explicit layer, re-imports the real module per case, and asserts the identical
conflict matrix (including the `envInt`/`envBool` illegal-value divergence).

**Limitation (recorded, not worked around):** this suite was **not executed here** because
`vitest`, `typescript` and `dotenv` are not installed in this checkout and dependencies must
not be installed. The dependency-free harness (§2) exercises the same source file and the
same assertions, and serves as the substitution evidence.

## 4. Citation verification

`.prale-eval/verify-citations.mjs` re-reads the current `TASK.md` (authoritative),
re-derives `task_id`/`repository`/`mode`, and programmatically checks that every cited
symbol truly occurs inside its inclusive `start_line`–`end_line` range in the cited file,
that the required path `MemoryPanel/src/panel/config/panel-config.ts` is cited and
claim-covered, and that every claim's `evidence_paths` are themselves cited.

```
node .prale-eval/verify-citations.mjs
```

## 5. Scope / non-changes

- No change to any repository source file, task metadata, hidden-oracle file, package lock,
  or git configuration.
- The only addition outside `.prale-eval/` is the new test file
  `MemoryPanel/tests/panel/panel-config.precedence.test.ts` (the requested precedence test,
  placed on the configured vitest include path).
- No dependency installed; no network/filesystem scan outside the workspace.

## 6. Ambiguity recorded

"explicit request input" is read as *the explicit, most-specific value supplied to the panel
process* (already present in `process.env` at launch) because `panel-config.ts` exposes no
HTTP-request-scoped override for these keys — the panel reads them once at startup. The
per-request instance identity (`x-tdai-service-id`) selects an entry from the config file
whose path is itself resolved by this same chain (§1, hand-off), which is what the
instance-config scenarios (I / I2) cover.
