# T21 — Offline operate delivery: model-catalog publish fixture

Repository: `pi` · Mode: `operate` · Task: operate an offline fixture that intentionally
lacks network data, run the narrowest valid local check, and report why it is offline-safe.

## 1. What was operated

Two local-only runs, both against JSON fixtures with **no network data**
(no `models.dev` payload, no provider `/models` responses, no R2 endpoint):

| # | Command | Result |
|---|---------|--------|
| 1 (primary, narrowest) | `TMPDIR="$PWD/.prale-eval/tmp" node --test scripts/publish-model-catalog.test.mjs` | `pass 1 / fail 0`, exit 0 |
| 2 (normalized operation result) | `node .prale-eval/offline-model-catalog-demo.mjs` | exit 0, wrote `.prale-eval/fixture/model-catalog/publication.json` |

The primary check is the repository's own focused `node:test` suite
(`scripts/publish-model-catalog.test.mjs`), which builds a temp JSON-only catalog
fixture and invokes `scripts/publish-model-catalog.mjs --dry-run`. `TMPDIR` was
pointed inside the workspace so the test's temporary writes stay local. No
`node_modules` is required: the suite and the script use Node built-ins only, plus
the TypeScript protocol module imported with Node's built-in type stripping.

The secondary run is the workspace-local executable demo
`.prale-eval/offline-model-catalog-demo.mjs`; it materializes a fixture under
`.prale-eval/fixture/model-catalog` and validates it through the same publisher.

## 2. Executable demo

```
.prale-eval/offline-model-catalog-demo.mjs   # fixture generator + validator
.prale-eval/fixture/model-catalog/
  models.json              # legacy chat-only catalog, keyed by provider+id
  models.all.json          # every type, keyed by provider
  providers.json           # sorted provider ids
  providers/<id>.json      # per-provider chat projection
  providers/<id>.all.json  # per-provider full shard
  publication.json         # normalized result written by the publisher
```

The demo builds 3 providers (anthropic 500 chat, openai 5 chat, openrouter 1 chat
+ 1 image + 1 classifier), writes the fixture, spawns
`node scripts/publish-model-catalog.mjs --input <fixture> --source-commit t21-offline-fixture --dry-run`,
asserts exit 0 and the `no objects uploaded` marker, then prints `publication.json`.

### Normalized operation result (`publication.json`)

```json
{
  "schemaVersion": 1,
  "minimumPiVersion": "0.80.7",
  "revision": "sha256-8fb10cb8e46d1c858d0faa7c2499d0ea47085fa2826f6913659aace5206dc0ff",
  "sourceCommit": "t21-offline-fixture",
  "providerCount": 3,
  "modelCount": 506,
  "chatModelCount": 506,
  "imageModelCount": 1,
  "classifierModelCount": 1,
  "totalModelCount": 508,
  "modelTypes": ["chat", "image", "classifier"]
}
```

The `revision` is the SHA-256 of the raw `models.all.json` bytes
(`scripts/publish-model-catalog.mjs:161`), so it is a deterministic function of the
fixture alone — reproducible with no external state.

## 3. Why the check is offline-safe

Traced path (line numbers are inclusive, from the current checkout):

1. `parseArgs` (`scripts/publish-model-catalog.mjs:36-71`) accepts `--input`,
   `--dry-run`, and an optional `--source-commit`. Lines 68-69 require
   `--bucket`/`--endpoint` **only when `dryRun` is false**, so the offline run
   needs no storage credentials or endpoint.
2. Supplying `--source-commit t21-offline-fixture` short-circuits
   `gitSourceCommit()` at `scripts/publish-model-catalog.mjs:271`, removing a
   subprocess invocation.
3. Validation is entirely local: `validateBundle` (`:85-166`) reads the fixture
   JSON files, checks the providers index matches the sorted providers in
   `models.all.json`, verifies the chat projection of `models.all.json` equals
   `models.json` and every provider shard, enforces the three required providers
   and `MINIMUM_MODEL_COUNT = 500`, then hashes the local bytes.
4. `main` (`:263-288`) writes `publication.json` locally (`:282`) and returns at
   `:285-288` with `no objects uploaded` **before** line 290 creates a temp dir
   and before `downloadIndex`/`uploadJson`.
5. The only network-capable code is `aws` (`:184-198`) and `downloadIndex`
   (`:200-213`, `s3 cp s3://$bucket/...`); both are unreachable from the dry-run
   branch. `aws` also sets `AWS_EC2_METADATA_DISABLED=true` (`:190`), so even the
   publish path avoids instance-metadata network calls.

The model-data side of the contract is consistent with this: in
`packages/ai/package.json` (`scripts` object, `:54-64`) `generate-models` (`:56`)
is the network-dependent step (it fetches `https://models.dev/api.json`),
`build:offline` (`:61`) deliberately omits it and instead runs `check:model-data`
(`:59`) plus a typecheck over committed data, and `generate-model-catalog` (`:58`)
emits the `.artifacts/model-catalog` JSON bundle that the publisher consumes. The
root `check:model-catalog` script runs the exact same offline command shape:
`node scripts/publish-model-catalog.mjs --input .artifacts/model-catalog --dry-run`.

## 4. Fixture contract enforced by the publisher

- `providers.json` == sorted `Object.keys(models.all.json)`, and `models.json`
  lists exactly the same providers.
- `anthropic`, `openai`, and `openrouter` must all be present.
- Each `providers/<id>.all.json` must deep-equal `models.all.json[id]`; each
  `providers/<id>.json` must equal the chat-only projection.
- Model entries need `type ∈ {chat, image, classifier}` with a string `id` and
  `provider` matching the shard; duplicate `type:id` identities are rejected.
- The provider shard file set must be exactly the two expected files per provider.
- At least 500 chat models must be present, or publication is refused.

## 5. Limitations

- `node_modules` is absent, so the workspace `vitest` suites and
  `tsgo` typecheck (`build:offline`) were not run; the offline task does not depend
  on them, and the chosen check needs no dependencies.
- The `aws` CLI is neither required nor invoked, so the upload path is verified by
  code-path trace (`:184-213`, `:285-288`) rather than by execution.
- No tracked file, lockfile, git configuration, or task metadata was modified;
  `git status --porcelain` reports only the new untracked `.prale-eval/` directory.
