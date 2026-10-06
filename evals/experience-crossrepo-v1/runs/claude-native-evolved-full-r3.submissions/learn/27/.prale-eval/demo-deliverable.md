# Demo deliverable — normalize markdown/frontmatter before indexing, reject malformed metadata

Task: learn/27 (`task_id` 27, repository `tdam`, mode `demo`).

## What the demo is

An executable, dependency-light Node script that gates markdown wiki pages before they
reach the index:

```
.prale-eval/demo/normalize-ingest-demo.mjs     # the demo (run it)
.prale-eval/demo/output/demo-run.json          # normalized operation result (generated)
```

Run it with:

```
node .prale-eval/demo/normalize-ingest-demo.mjs
```

It exits `0` only when every assertion about the normalization/rejection contract holds
(currently 25/25), and writes `demo-run.json` either way.

## The contract

Per document, in order:

| Step | Behavior |
| --- | --- |
| 1. Structural normalize | strip BOM, convert CRLF/CR to LF, strip per-line trailing whitespace, collapse 3+ blank lines, guarantee exactly one trailing newline, trim leading blank space. |
| 2. Split frontmatter | the `---\n…\n---` block is located with the same anchored regex the repo uses (`frontmatter.ts:36`); a document without a closing fence is not a frontmatter document. |
| 3. Validate raw metadata | validation reads the **raw parsed mapping, before** the repo parser's `type` coercion, because the coercion (`frontmatter.ts:60`) rewrites a malformed `type` to `"other"` and would otherwise make malformed metadata indistinguishable from absent metadata. |
| 4. Reject or accept | on any validation error the page is rejected with a typed code and `indexed: false`; nothing is written to the index. |
| 5. Canonicalize | accepted pages are re-serialized through the `buildPage` contract (`frontmatter.ts:85`): fixed field order, `type` always present, `locked` never written. |
| 6. Canonicalize source refs | repo-like `sources` entries are passed through `normalizeRepoUrl` (`normalize.ts:13`) and de-duplicated, so `git@host:ns/repo.git`, `ssh://git@host/ns/repo.git`, `https://host/ns/repo.git` and `host/ns/repo` all index as one identity. |
| 7. Index | accepted pages produce `{title, relPath, description, type, sources, sourceKey}` entries; rendering groups by type in the fixed `source → entity → concept → comparison → synthesis → other` order of `index-builder.ts`. |

### Rejection codes

| Code | Trigger |
| --- | --- |
| `E_NO_FRONTMATTER` | no closed `---` block |
| `E_YAML_INVALID` | block exists but does not parse (unterminated quote, unterminated flow sequence, bad indentation) |
| `E_YAML_NOT_MAPPING` | block parses to a scalar instead of a mapping |
| `E_TYPE_INVALID` | `type` absent or not a non-empty string (e.g. `type: [concept]`) |
| `E_TITLE_INVALID` / `E_DESCRIPTION_INVALID` / `E_TIMESTAMP_INVALID` | present but not a string |
| `E_TIMESTAMP_NOT_ISO` | timestamp present but not ISO-8601 |
| `E_SOURCES_NOT_ARRAY` / `E_TAGS_NOT_ARRAY` | declared as a scalar |
| `E_SOURCES_ITEM_INVALID` / `E_TAGS_ITEM_INVALID` | list contains an empty/non-string entry |
| `E_ROUNDTRIP` | the canonicalized page fails re-validation (self-check) |

Normalization is idempotent: feeding a canonical page back through the pipeline returns
byte-identical canonical output (asserted in the demo), mirroring the pass-through
property of `normalizeRepoUrl`.

## Normalized operation result

`node .prale-eval/demo/normalize-ingest-demo.mjs` on the eight built-in cases:

```
  ACCEPT                             messy-but-valid.md
  ACCEPT                             plain-valid.md
  REJECT(E_NO_FRONTMATTER)           unterminated-frontmatter.md
  REJECT(E_YAML_NOT_MAPPING)         scalar-frontmatter.md
  REJECT(E_YAML_INVALID)             bad-yaml.md
  REJECT(E_TYPE_INVALID)             wrong-type-field.md
  REJECT(E_SOURCES_NOT_ARRAY)        sources-not-array.md
  REJECT(E_TIMESTAMP_NOT_ISO)        bad-timestamp.md

assertions: 25/25 passed
```

The messy case is the clearest single result. Input (BOM, CRLF, padded title, the same
repo written twice in two spellings):

```
﻿---\r\ntype: source\r\ntitle:   Agent Memory overview  \r\n
sources: [git@gitlab.example.com:tencent/tdam/repo.git,
          https://gitlab.example.com/tencent/tdam/repo.git]\r\n---\r\n…
```

Normalized operation result (from `demo-run.json`):

```json
{
  "status": "accepted",
  "indexed": true,
  "entry": {
    "title": "Agent Memory overview",
    "relPath": "/sources/messy-but-valid.md",
    "type": "source",
    "sources": ["gitlab.example.com/tencent/tdam/repo"],
    "sourceKey": "gitlab.example.com/tencent/tdam/repo:main"
  }
}
```

and the rendered index contains only the accepted pages:

```
# Index

## source

* [Agent Memory overview](/sources/messy-but-valid.md) - Canonical page for the memory service

## concept

* [Retrieval pipeline](/concepts/plain-valid.md) - How pages reach the index
```

Summary from the run: `{"accepted":2,"rejected":6,"assertions":25,"failed":0}`.

## Grounding in the repository

| Repo symbol | Location | Role in the demo |
| --- | --- | --- |
| `normalizeRepoUrl` | `MemoryKnowledge/src/engines/code/normalize.ts:13-35` | imported and executed for real; canonicalizes `sources` refs (step 6) and its idempotence is asserted directly against five input spellings |
| `sourceKey` / `parseSourceKey` | `MemoryKnowledge/src/engines/code/normalize.ts:40-53` | imported and executed; the index entry's stable `sourceKey` and its round-trip assertion |
| `parseFrontmatter` | `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts:42-62` | defines step 2/3 semantics: tolerant parse, `type` coerced to `"other"`, `hasFrontmatter` flag |
| `buildPage` | `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts:85-102` | defines step 5: fixed field order, `type` default, `locked` never written |

`index-builder.ts` (`renderIndex`, fixed group order, "bad pages are skipped, never
thrown") is the index-side counterpart the demo's renderer mirrors.

## Validation and limitations

- Command: `node .prale-eval/demo/normalize-ingest-demo.mjs` → **pass**, exit 0, 25/25
  assertions, result in `.prale-eval/demo/output/demo-run.json`.
- `MemoryKnowledge/src/engines/code/normalize.ts` is loaded and executed directly
  (Node 24 strips TypeScript types at load time) — no build step was needed.
- `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts` could **not** be imported
  in this checkout: its `yaml` dependency is not installed (`node_modules/` is absent),
  so the dynamic import fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'`.
  The demo catches exactly that error and substitutes a dependency-free adapter that
  reproduces the exported contract (same frontmatter regex, same tolerant
  `parseFrontmatter`, same fixed-order `buildPage`). The adapter is labelled in the run
  output and in `demo-run.json` (`frontmatterSource`); no dependency was installed and
  no package file was modified. When `node_modules` is present, the repo module is used
  instead of the adapter for the tolerant parse/build path.
