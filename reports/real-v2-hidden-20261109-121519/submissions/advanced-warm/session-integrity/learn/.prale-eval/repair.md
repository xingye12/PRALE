# Repair: legacy credential migration loses BOM input and OAuth precedence

## Symptom

After upgrading a legacy agent dir, credentials vanished or an OAuth provider was
replaced by a stale settings API key:

- `oauth.json` / `settings.json` written with a UTF-8 BOM were not migrated at all
  (no `auth.json`, inputs left in place), so the session appeared logged out.
- When the settings file could be parsed, `settings.apiKeys` were written after the
  OAuth credentials, so a same-provider API key silently replaced the OAuth entry.

## Fault 1 — decoding: `packages/coding-agent/src/utils/text.ts`

`stripBom()` was a no-op (`return content`), while its sibling `splitBom()` did the
real work. Every caller that decodes JSON (migration, settings manager, auth storage,
themes, manifests, frontmatter, keybindings, models store, …) therefore passed a
leading `\uFEFF` to `JSON.parse`, which throws. In the migration the throw was
swallowed by the surrounding `catch`, producing the "credentials disappear" path.

Fix: implement `stripBom` in terms of the existing, already-correct `splitBom`, so
exactly one leading mark is removed and plain text / interior BOM characters are
returned verbatim. `splitBom` is untouched, so its public contract (`{ bom, text }`
with `bom + text === input`) still holds for all callers.

## Fault 2 — merge policy: `packages/coding-agent/src/migrations.ts`

`migrateAuthToAuthJson()` merged in the wrong direction. The OAuth pass ran first and
archived `oauth.json`, then the settings pass assigned
`migrated[provider] = { type: "api_key", key }` unconditionally for every string key,
overwriting an OAuth credential for the same provider. The fallback outranked the
primary source.

Fix: while walking `settings.apiKeys`, skip any provider already present in the merged
map (`!Object.hasOwn(migrated, provider)`). Because the OAuth pass populates that map
first, OAuth now wins provider-by-provider, while non-overlapping API keys still
migrate. No other behaviour changed:

- existing `auth.json` → early `return []` still short-circuits the whole function
  before any read, rename or write, so nothing is migrated, rewritten or archived;
- `oauth.json` is archived to `oauth.json.migrated` only inside the `try`, after the
  whole document was parsed and merged, so malformed input is neither moved nor
  rewritten;
- `settings.json` is rewritten only when an `apiKeys` object exists; only that key is
  deleted, so unrelated settings are retained, and a malformed settings file keeps its
  bytes;
- `auth.json` is only created when at least one credential was merged;
- the returned provider list stays consistent with what was actually migrated (no
  duplicate for the provider whose OAuth credential won).

Public APIs (`stripBom`, `splitBom`, `migrateAuthToAuthJson`) keep their signatures and
shapes; only the data selected for the merge changed.

## Why the fix must be cross-module

`migrateAuthToAuthJson()` decodes through `utils/text.ts`, so a working merge policy on
top of a no-op `stripBom` still loses both BOM-encoded sources, and a correct
`stripBom` on top of the old merge still lets the settings fallback clobber OAuth.
Neither module alone explains the incident; the regression therefore exercises the real
`migrations.ts` through the real `utils/text.ts` (and the real `session-manager.ts` link
provided by `.prale-eval/subject.mjs`), with only `getAgentDir` and directory listing
boundaries injected.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` — 8 uncaught
`node:assert/strict` scenarios over real module files plus on-disk fixtures under
`.prale-eval/` (removed before exit):

1. text helpers strip one leading BOM, keep plain/interior/double-leading BOM text,
   and `splitBom` remains lossless;
2. BOM-encoded OAuth + BOM-encoded settings apiKeys: OAuth kept for the overlapping
   provider, distinct key migrated, unrelated settings + interior BOM preserved,
   `oauth.json` archived byte-for-byte;
3. same contract for BOM-free (plain) inputs;
4. existing `auth.json` blocks all credential migration and leaves all three files
   byte-identical;
5. malformed `oauth.json` untouched (not archived) while API keys still migrate;
6. malformed `settings.json` untouched while OAuth migrates and archives;
7. settings without `apiKeys` create no `auth.json` and rewrite nothing;
8. re-running migration after a successful merge is a byte-identical no-op.

Mutation checks (each file restored alone to its faulty baseline, fixed tree
otherwise):

| restored baseline | result |
| --- | --- |
| `utils/text.ts` (`return content`) | `AssertionError [ERR_ASSERTION]` in scenario 1, exit 1 |
| `migrations.ts` (unconditional api-key assignment) | `AssertionError [ERR_ASSERTION]` (deep-equal on the reported/merged providers) in scenario 2, exit 1 |

Both mutations fail as assertion errors, not crash/import error/timeout, and the fixed
tree passes all scenarios with exit 0.

## Limitations

No package dependencies are installed in this workspace (none are required by the
task), so the repository's `vitest` suites and `tsgo`/`biome` type and lint checks were
not run; validation is limited to the VM-module regression above, which type-strips
both repaired files with Node 24's `stripTypeScriptTypes`.
