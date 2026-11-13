# Repair: legacy credential migration lost encoding and provider precedence

## Symptom

Upgrading from a legacy install (`oauth.json` + `settings.json.apiKeys`) where the JSON
files were written with a UTF-8 BOM produced an empty or partial `auth.json`, and when
both files carried the same provider the API-key fallback replaced the OAuth credential.

## Trace across the module boundary

1. `packages/coding-agent/src/migrations.ts` → `migrateAuthToAuthJson()` reads
   `oauth.json`, `settings.json` and writes `auth.json`. Both reads decode through
   `stripBom()` imported from `./utils/text.ts`.
2. `packages/coding-agent/src/utils/text.ts` → `stripBom()` was a no-op
   (`return content`). `splitBom()` next to it was correct, so the module exported two
   contradictory answers for the same question.

Consequence: `\uFEFF{"anthropic": ...}` reached `JSON.parse`, which throws. Each parse
site is wrapped in `try { } catch { }` ("skip on error"), so the failure is silent:
`oauth.json` is not archived, `settings.json.apiKeys` is not consumed, `migrated` stays
empty and no `auth.json` is written. Credentials appear to vanish. The same no-op also
broke every other `stripBom` consumer (frontmatter, settings, themes, `package.json`
reads, `auth-storage`).

Merge policy bug inside `migrateAuthToAuthJson()`: `oauth.json` was migrated first, then
the `settings.json` loop assigned `migrated[provider] = { type: "api_key", key }`
unconditionally, so an API key for the same provider overwrote the OAuth credential and
the provider was reported twice in the returned list.

## Fix

`packages/coding-agent/src/utils/text.ts`

```ts
export function stripBom(content: string): string {
	return splitBom(content).text;
}
```

`splitBom` removes exactly one leading `\uFEFF` and leaves every other character alone,
so plain text is returned unchanged, an interior BOM stays, and only a leading BOM is
dropped. Reusing `splitBom` keeps the two exports from drifting apart again; the public
API is unchanged.

`packages/coding-agent/src/migrations.ts`

- OAuth credentials are still merged first, and now the `apiKeys` fallback only fills
  providers that are not already present (`!Object.hasOwn(migrated, provider)`), so a
  same-provider API key no longer overwrites OAuth and the provider is listed once.
  `Object.hasOwn` (not `!migrated[provider]`) keeps inherited `Object.prototype` keys from
  being mistaken for migrated credentials.
- The remaining behaviour is preserved and now covered by assertions: unrelated settings
  survive the `apiKeys` removal, `oauth.json` is archived as `oauth.json.migrated` only
  after a successful parse (malformed files keep their bytes and stay in place), a
  malformed `settings.json` is left untouched while OAuth still migrates, and a
  pre-existing `auth.json` short-circuits the whole function so no legacy file is read,
  archived or rewritten.

## Regression coverage

`.prale-eval/regression.mjs` links the real `utils/text.ts`, `utils/frontmatter.ts` and
`migrations.ts` through `.prale-eval/subject.mjs` (`createGraph`), faking only the
boundaries (`chalk`, `yaml`, `./config.ts`, `./core/keybindings.ts`) and using the real
`fs` builtin against throwaway directories under `.prale-eval/`. It asserts observable
behaviour across the boundary: a BOM-prefixed document parses in `frontmatter.ts`, and
BOM-encoded legacy files migrate into a correct `auth.json` with OAuth winning over the
API-key fallback.

Verified by restoring one file at a time to its faulty baseline:

- faulty `utils/text.ts` alone → `AssertionError` (credentials disappear, no `auth.json`);
- faulty `migrations.ts` alone → `AssertionError` (duplicate `anthropic` provider and the
  API key overwriting the OAuth credential).

Both failures are assertion failures, not crashes or import errors.

## Validation limitation

The workspace has no `node_modules`, so `tsc --noEmit`, biome and vitest could not be run
and no dependencies were installed. Validation is the Node 24 VM-module regression above;
the changed files keep erasable-only TypeScript syntax (`Object.hasOwn` is available in
the configured ES2022 lib).
