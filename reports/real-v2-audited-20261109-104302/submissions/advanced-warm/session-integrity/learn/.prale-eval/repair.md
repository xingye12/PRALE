# Repair: legacy credentials lose encoding and provider precedence

## Producer/consumer flow

`migrateAuthToAuthJson()` in `packages/coding-agent/src/migrations.ts` is the
consumer. It reads two legacy inputs from the agent directory with real fs IO
and decodes both through `stripBom()` from `packages/coding-agent/src/utils/text.ts`
(the producer of decoded text):

- `oauth.json` → `JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")))`
- `settings.json` → `JSON.parse(stripBom(content))`

The decoded values are merged into `auth.json`, the OAuth input is archived as
`oauth.json.migrated`, and the consumed `apiKeys` block is dropped from
`settings.json` while every other setting is written back.

## Defects

1. `utils/text.ts` — `stripBom()` was a no-op (`return content;`) while its
   sibling `splitBom()` implemented the correct rule. Every BOM-encoded input
   therefore reached `JSON.parse()` with a leading U+FEFF, threw, and was
   swallowed by the migration's per-file `catch`. Result: OAuth credentials and
   settings API keys silently disappeared and the OAuth input was never even
   archived (no credential file appeared at all).

2. `migrations.ts` — settings API keys were merged after OAuth with an
   unconditional assignment:

   ```ts
   if (typeof key === "string") {
       migrated[provider] = { type: "api_key", key };
       providers.push(provider);
   }
   ```

   For a provider present in both inputs, the settings fallback overwrote the
   OAuth credential and the provider was reported twice. This is data
   destruction, not a merge: OAuth is the richer credential and must win.

## Fix

- `stripBom()` now delegates to the existing `splitBom()` and returns
  `text`, so exactly one leading BOM is removed. Plain text, interior BOMs,
  trailing BOMs and a second leading BOM are preserved byte-for-byte — the
  function is a decoder, not a sanitizer. `splitBom()` itself is unchanged and
  keeps its public contract, so other consumers (edit tools, frontmatter,
  settings manager, theme loader, …) are unaffected.
- The API-key merge is now guarded by `migrated[provider] === undefined`, so a
  provider already populated from `oauth.json` is neither overwritten nor
  reported twice. Providers that exist only in `settings.json` still migrate as
  `{ type: "api_key", key }`. Unrelated settings keys are untouched by the
  existing `delete settings.apiKeys` + write-back, successful OAuth input is
  still renamed to `oauth.json.migrated` only after a successful parse, and the
  `existsSync(authPath)` early return still blocks all credential migration when
  `auth.json` already exists.

Both changes are minimal and keep the existing exported APIs.

## Validation

`.prale-eval/regression.mjs` builds the real module graph with
`.prale-eval/subject.mjs` (`createSessionPipeline`: real `migrations.ts`, real
`utils/text.ts`, real `fs`/`path`; only `config.ts` and the keybindings boundary
are synthesized) and asserts across the text → migration boundary on isolated
agent directories under `.prale-eval/`:

- `stripBom` on plain text, leading BOM, double leading BOM, interior, trailing
  and embedded BOMs; `splitBom` contract.
- BOM-encoded `oauth.json` + BOM-encoded `settings.json`: OAuth wins for a
  shared provider, other providers become API keys, interior BOMs survive both
  decodes, unrelated settings (`theme`, `defaultModel`, `compaction`) are
  retained, `apiKeys` is consumed, and the OAuth input is archived byte-for-byte
  at `oauth.json.migrated`.
- Malformed `oauth.json`: left in place, unarchived, byte-identical, while
  settings API keys still migrate.
- Malformed `settings.json`: left byte-identical while OAuth still migrates and
  is archived.
- Pre-existing `auth.json`: no migration, no rewrites, nothing archived.
- Plain (BOM-free) settings API keys still migrate.

Detection was checked by restoring each faulty baseline in isolation:

- `stripBom` no-op only → `AssertionError: leading BOM must be removed` (exit 1).
- unguarded API-key merge only → `AssertionError: OAuth providers must precede
  new API-key providers` (exit 1).

Both failures are assertion failures, not import/crash errors. Temporary inputs
are created under `.prale-eval/.regression-tmp` and removed in a `finally`
block, so no state is left behind.
