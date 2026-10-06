# Operate deliverable — offline model-catalog publisher dry run (`pi`, task T26)

## What was operated

The repository checkout is an **offline fixture**: the network-derived model data that
`@earendil-works/pi-ai` normally hydrates at build time is intentionally not present
(`packages/ai/src/providers/data/` is absent and gitignored), and the scripts that would
produce it (`generate-models`, `hydrate-model-data`) perform live `fetch()` calls against
provider APIs. Running them would require network access, which this environment does not have.

The **narrowest valid local check** that still exercises real repository behaviour is the
catalog publisher's dry-run path in `scripts/publish-model-catalog.mjs`. It validates a fully
materialized bundle, writes the normalized publication record, and returns **before** the only
network-touching code (`aws()` → AWS CLI S3 copy).

To operate it offline, a self-contained bundle with no network data was materialized locally at:

```
.prale-eval/fixture/model-catalog/
├── models.json                      # legacy chat-only catalog (provider -> id -> model)
├── models.all.json                  # full catalog (provider -> model[] with typed entries)
├── providers.json                   # sorted provider ids: ["anthropic","openai","openrouter"]
├── providers/<provider>.json        # chat projection of that provider
├── providers/<provider>.all.json    # every type of that provider
└── publication.json                 # produced by the operated command (normalized result)
```

The fixture is generated deterministically from local JSON only (498 `anthropic` chat models,
2 `openai` chat models, 1 `openrouter` chat model, 1 `openrouter` image model, 1 `openrouter`
classifier model), so the revision hash is reproducible without any remote metadata.

## Executed command

```sh
node scripts/publish-model-catalog.mjs \
  --input .prale-eval/fixture/model-catalog \
  --source-commit 669a8c6e8cdd6b8e8d0e6712b1ca1acee3def168 \
  --dry-run
```

Exit status: **0**. Raw stdout/stderr captured in `.prale-eval/dry-run.stdout.log`.

## Normalized operation result

The command printed (and persisted to `.prale-eval/fixture/model-catalog/publication.json`):

```json
{
  "schemaVersion": 1,
  "minimumPiVersion": "0.80.7",
  "revision": "sha256-be07e8c3d434c1e871fd56089844fe59123234ab563dc445c1dc3d7d99a2a119",
  "sourceCommit": "669a8c6e8cdd6b8e8d0e6712b1ca1acee3def168",
  "providerCount": 3,
  "modelCount": 501,
  "chatModelCount": 501,
  "imageModelCount": 1,
  "classifierModelCount": 1,
  "totalModelCount": 503,
  "modelTypes": ["chat", "image", "classifier"]
}
```

followed by:

```
Validated model catalog at <workspace>/.prale-eval/fixture/model-catalog; no objects uploaded.
```

## Contract enforced by the operated command

`validateBundle` (scripts/publish-model-catalog.mjs:85-176) accepts the bundle only when:

- `models.json` and `models.all.json` are objects holding the same sorted provider ids as
  `providers.json`;
- the required providers `anthropic`, `openai`, `openrouter` are present
  (`REQUIRED_PROVIDERS`, line 32);
- every entry has a string `id` equal to its provider key and a `type` in
  `["chat","image","classifier"]`, with no duplicate `type:id` per provider;
- the legacy `models.json` and each `providers/<id>.json` shard are exactly the chat projection of
  the full `models.all.json` shard for that provider (lines 140-147), and the shard file set matches
  `providers.json` exactly (lines 150-154);
- the chat model count meets `MINIMUM_MODEL_COUNT = 500` (lines 33, 155-157);
- the revision is `sha256-<hex64>` over the raw bytes of `models.all.json` (lines 159-174), so any
  chat/image/classifier change produces a new revision.

Downstream, the same revision is published under
`models/v1/revisions/<revision>/…` using `getModelCatalogArtifactKey` /
`getModelCatalogProviderKey` from `scripts/model-catalog-protocol.ts`, and the index entry built by
`buildIndex` keeps the highest `minimumPiVersion` per revision; the dry run stops before all of that.

## Why this check is offline-safe

1. **No network configuration required.** `parseArgs` requires only `--input`; `--bucket` and
   `--endpoint` are enforced only when `--dry-run` is absent (lines 67-69).
2. **Early return before the network branch.** `main` writes `publication.json`, prints it, and
   returns at lines 285-288 while `options.dryRun` is set — before `mkdtempSync`, `downloadIndex`
   and `uploadJson`.
3. **Single egress point, unreachable.** The only network code is `aws()` (lines 184-198), which
   shells out to the AWS CLI; its callers are reached only after the dry-run guard. The AWS CLI is
   not installed in this environment (`command -v aws` → not found).
4. **No fetch/HTTP/SDK dependency.** The module imports only `node:crypto`, `node:fs`, `node:os`,
   `node:path`, `node:child_process`, `node:util` and the local `./model-catalog-protocol.ts`.
5. **Fixture is local-only.** The bundle is synthesized from local JSON; it embeds no remote
   metadata and requires no credentials, tokens or endpoint.

## Reproducing / verifying

```sh
# regenerate the fixture (deterministic, offline) and re-run the operated command
node scripts/publish-model-catalog.mjs --input .prale-eval/fixture/model-catalog \
  --source-commit "$(git rev-parse HEAD)" --dry-run

# secondary focused check: the repository's own offline test for the same path
node --test scripts/publish-model-catalog.test.mjs   # 1 test, 1 pass, 0 fail
```

Both commands run with zero network access and no `node_modules`.

## Limitations recorded for this fixture

- `packages/ai/src/providers/data/` is intentionally absent and gitignored, so
  `npm --prefix packages/ai run check:model-data` fails with
  `ENOENT: ... packages/ai/src/providers/data/amazon-bedrock.json`. The offline entry point
  `build:offline` (packages/ai/package.json line 61) depends on that hydrated data and cannot be
  completed here.
- The network-refreshing steps `generate-models` / `hydrate-model-data` (packages/ai/package.json
  lines 56-58, implemented in `packages/ai/scripts/generate-models.ts` with live `fetch()` calls)
  were deliberately not executed.
- Consequently the root script `npm run check:model-catalog`, which points at
  `.artifacts/model-catalog`, cannot be exercised because that bundle cannot be produced without
  network data. The publisher dry run above validates the identical code path with a local bundle.
- Vitest/TypeScript suites (e.g. `packages/ai/test`, `scripts/model-catalog-protocol.test.ts` via
  vitest) were not executed because the fixture has no installed dependencies; the `node:test`
  based script tests (`scripts/*.test.mjs`, executed with the Node 24 built-in runner and native
  type stripping) cover the same publisher/protocol behaviour.
