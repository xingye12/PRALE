# Operate deliverable — offline model-catalog validation

Task: `T26` · Repository: `pi` · Mode: `operate`

## Normalized operation result

| Field | Value |
| --- | --- |
| Operation | Validate a model-catalog bundle locally and emit `publication.json` |
| Command run | `node --test scripts/publish-model-catalog.test.mjs` |
| Exit status | `0` (pass) |
| Tests | 1 passed, 0 failed |
| Network required | No |
| Fixture | Generated in-process under `os.tmpdir()` |

## Executable demo / contract

The repository ships a publish tool, `scripts/publish-model-catalog.mjs`, whose contract is:

```sh
node scripts/publish-model-catalog.mjs --input <dir> [--source-commit <sha>] --dry-run
```

In `--dry-run` the tool:

1. `parseArgs` requires `--input` and, only when *not* dry-running, `--bucket`/`--endpoint`
   (`scripts/publish-model-catalog.mjs:36-71`).
2. `validateBundle(inputDir)` reads `models.json`, `models.all.json`, `providers.json`, and
   `providers/<id>.json` / `providers/<id>.all.json` from the local input directory only
   (`scripts/publish-model-catalog.mjs:85-176`). It checks:
   - every catalog file is an object / the provider index is a sorted string array;
   - `models.json` equals the chat projection of `models.all.json` for each provider;
   - shard files match the index and the full catalog;
   - all three `REQUIRED_PROVIDERS` (`anthropic`, `openai`, `openrouter`) are present;
   - model types are within `chat | image | classifier` and identities are unique;
   - the chat count meets `MINIMUM_MODEL_COUNT = 500`;
   - it computes `revision = sha256-<digest>` over the local `models.all.json` bytes.
3. `main()` writes `publication.json` into the input directory and returns at
   `scripts/publish-model-catalog.mjs:285-288` — **before** any call to `downloadIndex` /
   `uploadJson`, i.e. before any `aws s3` subprocess is spawned.

Only the non-dry-run branch (`main`, lines 263-325) reaches the S3 helpers.

## Why this check is offline-safe

- The check **generates its own fixture**: the test builds the provider files in a fresh
  `mkdtempSync(join(tmpdir(), ...))` directory, so it does not depend on the repository's
  generated `.artifacts/model-catalog` bundle, which is intentionally absent in this fixture
  repository.
- The exercised code path is the `--dry-run` early return, which never constructs upload keys and
  never invokes the `aws` CLI (`aws`, `downloadIndex`, `uploadJson` are unreachable).
- Only Node builtins (`node:fs`, `node:crypto`, `node:os`, `node:path`, `node:child_process`,
  `node:util`, `node:test`, `node:assert`) and a repository-local TypeScript module
  (`./model-catalog-protocol.ts`) are imported; **no `node_modules` install and no network access
  are needed**.

## Related package scripts (contract source)

`packages/ai/package.json` (`scripts`, lines 54-64) defines the local data pipeline that produces the
dry-run input:

- `generate-model-catalog` → `node scripts/generate-models.ts --strict --json-only --json-output ../../.artifacts/model-catalog`
- `check:model-data` → `node scripts/check-model-data.ts`
- `build:offline` → local-only (`check:model-data`, `tsgo`, `shx` copies), no network fetch

## Observed output

```
✔ publishes explicit per-type and total model counts (135.031053ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

The test asserts the normalized publication counts: `chatModelCount = 500`,
`imageModelCount = 1`, `classifierModelCount = 1`, `totalModelCount = 502`, with
`modelCount` retained as the legacy chat-only count (500).

## Limitation

The root `npm run check:model-catalog` dry-run (which consumes `.artifacts/model-catalog`) was not
run, because that generated bundle is intentionally absent from this offline fixture. The
self-contained unit test above is the narrowest check that validates the same `validateBundle`
contract without network data.
