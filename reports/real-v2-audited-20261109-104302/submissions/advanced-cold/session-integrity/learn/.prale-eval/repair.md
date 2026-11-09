# Legacy credential migration: cross-module repair

## Symptom

A legacy upgrade produced by BOM-encoded `oauth.json` (and BOM-encoded
`settings.json`) lost credentials: nothing ended up in `auth.json`. When the files
were readable, an API key from `settings.json.apiKeys` replaced an OAuth
credential for the same provider.

## Producer / consumer flow

```
readFileSync("utf-8")  ──►  stripBom()          ──►  JSON.parse()  ──►  migration policy
(raw text, may start                       (utils/text.ts)            (migrations.ts)
 with U+FEFF)                                    producer                     consumer
```

`packages/coding-agent/src/utils/text.ts` is the single decoding producer for the
migration consumers in `packages/coding-agent/src/migrations.ts`
(`migrateAuthToAuthJson`, `migrateKeybindingsConfigFile`). Both defects lived on
this seam:

1. **Producer regression — `stripBom` was a no-op** (`return content;`). A leading
   U+FEFF therefore reached `JSON.parse`, which throws, and the `catch` blocks in
   the migration silently skipped the file: the credentials "disappeared". The
   no-op was also wrong in the opposite direction for anyone who tried to "fix"
   it with a global replace: interior U+FEFF characters inside keys must survive.

2. **Consumer regression — merge policy had no precedence guard.** `oauth.json`
   was processed first, then every string in `settings.json.apiKeys` was written
   into the same map, so a same-provider API key overwrote the fresher OAuth
   credential (and the provider was reported twice).

## Fix

`utils/text.ts`

- `stripBom` now delegates to `splitBom`, i.e. it removes exactly one leading
  U+FEFF (`"\uFEFF" + json` → `json`), and returns plain text and text with
  interior/trailing U+FEFF unchanged. `splitBom` keeps its existing contract
  (`{ bom, text }`), so all other consumers (theme, frontmatter, settings,
  auth-storage, edit tool, …) keep their behavior.

`migrations.ts` — `migrateAuthToAuthJson`

- Both inputs are decoded through the repaired `stripBom`, so BOM-prefixed legacy
  files parse instead of vanishing into the `catch` branch.
- OAuth is merged first **and** the API-key pass skips any provider already
  migrated (`Object.hasOwn(migrated, provider)`), so OAuth wins and each migrated
  provider is reported exactly once.
- Unrelated settings are retained: the settings rewrite only deletes `apiKeys`,
  leaving `defaultModel`, `theme`, … intact.
- `oauth.json` is archived as `oauth.json.migrated` only after its content has
  been fully read and merged (successful OAuth input).
- Malformed data is left untouched: a syntactically invalid file, or a document
  whose decoded root is not a JSON object (array / `null` / primitive), is
  skipped without archiving or rewriting; unusable per-provider entries are
  skipped instead of corrupting the archive. Individual `try`/`catch` blocks keep
  the two sources independent, so a bad `oauth.json` still lets `apiKeys`
  migrate (and vice versa).
- An existing `auth.json` still short-circuits the whole function (`return []`),
  so no credential is migrated, no `oauth.json` is archived and no `settings.json`
  is rewritten.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (Node 24, no
dependencies). It links the real submitted `migrations.ts`, `utils/text.ts` and
`core/session-manager.ts` through `.prale-eval/subject.mjs`, with only `fs`'s
`readdirSync` ordering and `getAgentDir` substituted; all IO happens in a
throwaway `.prale-eval/tmp/` sandbox that the script deletes on exit, and
scenarios run sequentially through `await` so ordering is controlled.

Covered behaviors: leading/plain/interior/trailing BOM decoding; BOM-encoded
`oauth.json` + `settings.json` migration with byte-exact archiving; OAuth over
same-provider API keys with single reporting; retention of unrelated settings;
interior-BOM keys preserved in `auth.json`; malformed oauth syntax, malformed
oauth shape and malformed settings left byte-identical while the healthy source
still migrates; existing `auth.json` blocking all migration.

Mutation check (executed locally, each source restored to its faulty baseline on
its own):

| Restored baseline | Result |
| --- | --- |
| `utils/text.ts` only (`stripBom` no-op) | fails: `AssertionError: a leading BOM must be removed` (exit 1) |
| `migrations.ts` only (unguarded `apiKeys` merge) | fails: `AssertionError: OAuth must not be overwritten by a same-provider API key` (exit 1) |
| both baselines | fails (exit 1) |
| repaired tree | `regression: all legacy credential migration checks passed` (exit 0) |

Limitation: no `node_modules` are installed in this workspace, so `tsc`/`vitest`
could not be run; validation is the Node-only regression above.
