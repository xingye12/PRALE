# T26 — Offline operation of the pi model-catalog fixture

## What was operated

The model-catalog publisher in `scripts/publish-model-catalog.mjs` run in its
`--dry-run` mode against a self-contained, local model-catalog fixture. The
fixture intentionally carries **no network data**: no S3 bucket, no endpoint,
no credentials, no downloaded `index.json`. Nothing in the exercised path
reaches the network.

## Narrowest valid local check

```sh
node --test scripts/publish-model-catalog.test.mjs
```

Result: **1 test, 1 pass, 0 fail** (Node v24.14.0).

That test (`scripts/publish-model-catalog.test.mjs`) builds a fixture in a
`tmpdir` and spawns:

```sh
node scripts/publish-model-catalog.mjs \
  --input <fixture> --source-commit test-commit --dry-run
```

The identical operation was additionally run directly against a materialized
fixture to capture a durable normalized result:

```sh
node scripts/publish-model-catalog.mjs \
  --input .prale-eval/fixture --source-commit offline-fixture --dry-run
```

Exit code `0`, final line: `Validated model catalog at .../.prale-eval/fixture; no objects uploaded.`

## Why it is offline-safe

1. **`--dry-run` returns before any network call.** In `main()`
   (`scripts/publish-model-catalog.mjs:263-288`) the dry-run branch at lines
   285-288 prints its confirmation and `return`s. Every network touch —
   `spawnSync("aws", ...)` (line 185), `downloadIndex` (line 200, called at 293)
   and `uploadJson` (line 215, called at 314 and 320) — is located strictly
   after that return, so it is unreachable in dry-run.
2. **No bucket/endpoint required.** `parseArgs` (lines 36-71) only enforces
   `--bucket`/`--endpoint` when *not* dry-running (lines 68-69), so an offline
   run needs no target configuration.
3. **No git subprocess.** `--source-commit offline-fixture` supplies the value
   directly, bypassing `gitSourceCommit()` (`git rev-parse`, line 178).
4. **Node builtins + one local module only.** The publisher imports
   `node:crypto`, `node:fs`, `node:os`, `node:path`, `node:child_process`,
   `node:util` and the local `./model-catalog-protocol.ts`. The test and
   `packages/ai/scripts/check-model-data.ts` likewise use only `node:` modules.
   No `node_modules` are installed or needed.

## Fixture shape (the contract exercised)

| File | Role |
| --- | --- |
| `models.json` | legacy chat-only catalog (provider → id → model) |
| `models.all.json` | typed full catalog (chat + image + classifier) |
| `providers.json` | sorted provider ids |
| `providers/<id>.json` / `providers/<id>.all.json` | per-provider shards |

`validateBundle` (lines 85-176) asserts the shards match the aggregates, that
`models.json` is exactly the chat projection of `models.all.json`, that the
required providers (`anthropic`, `openai`, `openrouter`) exist, that model ids
are unique per type, and that at least `MINIMUM_MODEL_COUNT = 500` chat models
are present.

## Normalized operation result

Captured in `.prale-eval/operation-result.json`:

```json
{
  "schemaVersion": 1,
  "minimumPiVersion": "0.80.7",
  "revision": "sha256-a9e95677ae6d595ce925d4ec3ae9ea2d35e09826cdcc00984b6e034b65777918",
  "sourceCommit": "offline-fixture",
  "providerCount": 3,
  "modelCount": 500,
  "chatModelCount": 500,
  "imageModelCount": 1,
  "classifierModelCount": 1,
  "totalModelCount": 502,
  "modelTypes": ["chat", "image", "classifier"]
}
```

The `revision` is `sha256-<sha256(models.all.json bytes)>` (line 161), a
deterministic local hash — reproducible without any external state.

## Reproduce

```sh
# regenerate the fixture, then validate it locally
node scripts/publish-model-catalog.mjs \
  --input .prale-eval/fixture --source-commit offline-fixture --dry-run
```

The fixture files live under `.prale-eval/fixture/`; the normalized result is
`.prale-eval/operation-result.json`. Only `.prale-eval/` was written; no task
metadata, hidden-oracle files, package locks, or git configuration were
modified.
