# Repair: legacy credential decoding and merge policy

Task: `advanced/session-integrity/learn` — repository `earendil-works/pi`.

## Incident summary

A legacy upgrade with BOM-encoded `oauth.json` and `settings.json` lost every
credential, and — when decoding did work — the `settings.json` `apiKeys`
fallback overwrote OAuth credentials for the same provider.

## Faults and fixes (two production files)

### 1. `packages/coding-agent/src/utils/text.ts` — decoding

`stripBom()` was a no-op (`return content;`), so a leading UTF-8 BOM survived
into `JSON.parse()` in every caller (`migrations.ts`, `auth-storage.ts`,
`settings-manager.ts`, `keybindings.ts`, `resource-loader.ts`, …). A BOM-prefixed
JSON document is rejected by `JSON.parse`, and the migration's `try/catch`
swallowed the parse error, so the legacy files were silently skipped and the
credentials "disappeared".

`stripBom()` now delegates to the already-correct `splitBom()` helper and drops
exactly one leading `U+FEFF`:

- leading BOM removed: `"\uFEFF{...}"` → `"{...}"`
- plain text untouched
- interior / trailing BOMs preserved (they are content, not encoding markers)
- only the first of several leading BOMs is removed

`splitBom()` and both public signatures are unchanged, so all existing callers
keep working.

### 2. `packages/coding-agent/src/migrations.ts` — merge policy

`migrateAuthToAuthJson()` processed `oauth.json` first and then assigned every
`settings.json` API key with `migrated[provider] = {...}`, so a same-provider
API key unconditionally overwrote the OAuth credential that was just migrated
(the "fallback overwrites OAuth" symptom). The repair keeps the same public API
and structure but makes the policy explicit:

- `oauth.json` is still consumed first; `settings.json` `apiKeys` now skip any
  provider that already has a migrated OAuth credential (`Object.hasOwn`), so
  **OAuth wins** for the same provider, while API-key-only providers still
  migrate (non-string values are still ignored).
- Each provider is reported once in the returned `providers` array.
- **Unrelated settings are retained**: only `apiKeys` is deleted from the parsed
  document before it is written back, and the value is re-serialized from the
  parsed object, so `theme`, `defaultModel`, nested objects and interior-BOM
  strings round-trip unchanged. `settings.json` is only rewritten when it was
  successfully parsed and actually contained an `apiKeys` object.
- **Archive successful OAuth input only**: `oauth.json` → `oauth.json.migrated`
  happens inside the same `try` block, after the document has been parsed and
  harvested, so a malformed `oauth.json` is never renamed or rewritten.
- **Malformed data is left untouched**: parse failures in `oauth.json` /
  `settings.json` still fall through to the catch blocks, which no longer write
  or rename anything; a malformed `oauth.json` therefore does not prevent a
  valid `settings.json` from migrating (and vice versa).
- **An existing `auth.json` prevents all credential migration**: the early
  `existsSync(authPath)` return stays ahead of every read/write/rename, so no
  legacy file is consumed, archived or overwritten.
- A small `isRecord()` guard replaces the loose `typeof x === "object"` checks so
  that JSON `null`/arrays at the top level or in `apiKeys` are treated as
  malformed instead of producing bogus provider entries or a `TypeError` driven
  rewrite.

### Cross-module interaction

`migrations.ts` imports `stripBom` from `utils/text.ts`; the migration's ability
to consume BOM-encoded credentials depends entirely on the input utility, while
the utility's correct behavior is only observable end-to-end through the
migration's output files. The regression test therefore covers both layers
through the real module graph.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs`

`.prale-eval/regression.mjs` links the real `migrations.ts`, `utils/text.ts` and
`session-manager.ts` through the read-only `subject.mjs` helper
(`createSessionPipeline`), writes real fixtures under `.prale-eval/.tmp/`
(removed on success and on failure via `process.on("exit")`), and asserts with
uncaught `node:assert/strict` assertions:

1. `stripBom`/`splitBom` decoding semantics (leading vs. plain vs. interior BOM).
2. BOM-encoded `oauth.json` + `settings.json`: credentials appear, OAuth wins
   over the same-provider API key, API-key-only providers migrate, non-string
   keys are ignored, unrelated settings and interior-BOM values are retained,
   and `oauth.json` is archived byte-identically as `oauth.json.migrated`.
3. The same merge policy for plain (non-BOM) legacy files.
4. Malformed `oauth.json` is left byte-identical and un-archived while a valid
   `settings.json` still migrates.
5. An existing `auth.json` short-circuits everything: empty provider list and all
   three files byte-identical.
6. No legacy files produce no `auth.json`.

Regression detection was verified by restoring each faulty baseline separately:
with only `utils/text.ts` reverted the script fails with an `AssertionError`
(`'\uFEFFoauth' !== 'oauth'`, and the migration scenario would follow), and with
only `migrations.ts` reverted it fails on the OAuth-precedence assertion. Both
failures are assertion failures (non-zero exit), not crashes or import errors.
