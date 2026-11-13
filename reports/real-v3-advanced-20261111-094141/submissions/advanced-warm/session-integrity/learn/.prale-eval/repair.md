# Repair: legacy credential encoding and provider precedence

Task: `advanced/session-integrity/learn` — repository `earendil-works/pi`.

## Incident trace

The legacy upgrade path is a producer/consumer chain:

1. `packages/coding-agent/src/utils/text.ts` — the decoding utility (`splitBom`, `stripBom`).
   Every JSON reader in the process goes through it, including the migration and the
   credential store's `auth.json` reader.
2. `packages/coding-agent/src/migrations.ts` → `migrateAuthToAuthJson()` — the migration that
   folds legacy `oauth.json` and `settings.json#apiKeys` into `auth.json`.
3. `packages/coding-agent/src/core/auth-storage.ts` — the consumer (`ReadOnlyAuthStorage`,
   `AuthStorage`, `readStoredCredential`) that parses `auth.json` with the same utility.

Two independent faults combined into the reported outage:

### Fault 1 — the input utility did not decode at all

`stripBom(content)` returned `content` unchanged. It was a no-op, so any UTF-8 BOM that survived
decoding reached `JSON.parse` as a leading `\uFEFF`. BOM-prefixed `oauth.json`, `settings.json`
and `auth.json` files all failed to parse, which made credentials "disappear":

* the migration's `try/catch` swallowed the parse error, so OAuth credentials were silently skipped;
* `ReadOnlyAuthStorage.load()` threw `Failed to read auth.json`.

### Fault 2 — the migration merged with the wrong precedence

`migrateAuthToAuthJson()` migrated `oauth.json` first, then unconditionally overwrote the same
provider with `settings.json#apiKeys`:

```ts
migrated[provider] = { type: "api_key", key }; // clobbers an already-migrated OAuth credential
```

So an OAuth grant — which cannot be recreated from an API key — was replaced by the weaker legacy
fallback, and the provider was reported twice. Additionally, an `oauth.json` that parsed into a
non-object (`"text"`, `[...]`) was still archived and produced junk credentials, and api keys
that could not be represented were dropped silently.

## Fix

### `packages/coding-agent/src/utils/text.ts`

```ts
export function stripBom(content: string): string {
	// Only a single leading BOM is dropped: plain text and interior BOMs stay intact.
	return splitBom(content).text;
}
```

`splitBom` already had the correct contract (`startsWith("\uFEFF") ? slice(1) : content`), so
`stripBom` now reuses it. Consequences: plain text is untouched, exactly one leading BOM is
removed, interior BOMs and repeated leading BOMs after the first are preserved, and every consumer
(`auth-storage`, `settings-manager`, `models-store`, `theme`, `frontmatter`, `file-processor`, …)
regains documented behavior without any API change.

### `packages/coding-agent/src/migrations.ts`

* Added a private `parseJsonRecord()` helper: parses `stripBom`-decoded text, returns `undefined`
  for unparsable/blank/non-object input, and never rewrites the source file on failure.
  Malformed legacy files are therefore left byte-for-byte untouched.
* `oauth.json` is migrated first, entries must be objects, and the result is always tagged
  `type: "oauth"` (`{ ...credential, type: "oauth" }`).
* Archiving (`oauth.json` → `oauth.json.migrated`) now happens only after the input was
  successfully parsed and migrated, and it is a best-effort rename (a rename failure no longer
  discards already-migrated credentials).
* `settings.json#apiKeys` entries are merged with OAuth precedence: `if (provider in migrated)
  continue;` keeps the OAuth credential. Providers are reported exactly once.
* Entries that cannot be represented in `auth.json` (non-string values) are kept in
  `settings.json` instead of being dropped; all other settings keys are preserved because the
  parsed object is rewritten in place with only `apiKeys` (fully migrated) removed. The file is
  only rewritten when something actually changed.
* Pre-existing behavior preserved: `auth.json` existing short-circuits the whole migration
  (`return []`), and nothing is written when no provider migrated.

No public API changed: `migrateAuthToAuthJson(): string[]`, `runMigrations()` and all
`auth-storage` exports keep their signatures and unrelated behavior.

## Regression suite (`.prale-eval/regression.mjs`)

Run: `node --experimental-vm-modules .prale-eval/regression.mjs`

The suite links the **real** `utils/text.ts`, real `migrations.ts` and real `core/auth-storage.ts`
through `.prale-eval/subject.mjs` (`createGraph` with an explicit entry list so `./utils/text.ts`
resolves to the real module). Boundary fakes are supplied by the test: `getAgentDir`/`getBinDir`/
`CONFIG_DIR_NAME`, `chalk`, `migrateKeybindingsConfig`, `normalizePath`, `getFileRevision`,
`raceWithAbortSignal`, `isCommandConfigValue`, `resolveConfigValue` and `proper-lockfile`.
Real `fs`/`path` builtins are used against temporary directories under
`.prale-eval/.regression-work`, which are removed on process exit.

Scenarios (all uncaught `node:assert/strict` assertions, values normalized across the VM realm):

1. BOM-encoded `oauth.json` + BOM-encoded `settings.json` with a same-provider key: all three
   providers migrate once, OAuth wins over the API key, interior BOMs inside key material survive,
   `auth.json` has no BOM, `oauth.json` is archived byte-identically as `oauth.json.migrated`, and
   unrelated settings (`theme`, nested `editor`, a value containing a BOM) are retained.
2. The same migrated `auth.json` is read back through the real `ReadOnlyAuthStorage` with
   `Promise.all([...])` to pin asynchronous ordering: OAuth and API-key credentials and
   `list()` metadata match what the migration wrote.
3. `stripBom`/`splitBom` semantics through the real utility module (plain, single leading BOM,
   double BOM, interior BOM, empty), plus a BOM-free legacy upgrade that must still migrate.
4. Malformed `oauth.json` (with a leading BOM): untouched, not archived, settings keys still migrate.
5. Malformed `settings.json`: untouched, OAuth still migrates and is archived.
6. Unusable legacy input (`[1,2,3]` and a bare string): no `auth.json`, both files byte-identical.
7. Existing `auth.json` blocks all migration (nothing rewritten, nothing archived) and the
   credential store still reads the pre-existing credential; `runMigrations()` reports providers once.

Mutation evidence: restoring `utils/text.ts` alone to the faulty baseline fails scenario 1 with
`[] !== ['anthropic','openai','local']` (assertion, not a crash); restoring `migrations.ts` alone
fails scenario 1 with the duplicated provider list before the precedence assertions. Both were run
locally against the baselines and then reverted to the repair.

## Validation limits

`node_modules` is not installed by design (no dependency installation permitted in this
workspace), so the repository's `tsgo --noEmit` type check, `biome check` and `vitest` suites could
not be executed here; the focused Node validation above is the recorded evidence, and it loads the
submitted TypeScript sources directly via `stripTypeScriptTypes`.
