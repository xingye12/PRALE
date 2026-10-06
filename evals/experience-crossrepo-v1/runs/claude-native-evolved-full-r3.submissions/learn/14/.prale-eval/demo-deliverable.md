# Demo — wiki-ingest helpers on a local markdown corpus

Task `14` · repository `tdam` · mode `demo`

Executable demo of the wiki-ingest helpers (`slug`, frontmatter, chunker) that
ingests a small local markdown corpus and emits **deterministic document IDs and
chunk counts**.

## Run it

```bash
node .prale-eval/demo/run-demo.mjs
```

Exit status `0`. Writes `.prale-eval/demo/out.json` and prints a per-document
summary. Running it twice produces byte-identical output (verified by diffing
two consecutive runs).

## Inputs

`.prale-eval/demo/corpus/` — 4 hand-written markdown files:

| file | type | title | exercises |
|------|------|-------|-----------|
| `redis-cluster.md` | `entity` | `Redis Cluster` | frontmatter + multi-chunk body (>1000 chars) |
| `streams.md` | `concept` | `Redis Streams` | frontmatter + `sources` list |
| `无-frontmatter-笔记.md` | *(none)* | *(filename)* | missing-frontmatter fallback + CJK slug |
| `locking.md` | `concept` | `手工锁定页` | `locked: true` detection |

## Contract exercised

| helper | source | behavior relied on |
|--------|--------|--------------------|
| `parseFrontmatter` / `isLocked` / `readSources` | `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts:42-76` | split `---` YAML block; tolerant fallback `{type:"other"}` when absent/malformed; `locked === true` detection; `sources` string-array filtering |
| `buildPage` | `…/frontmatter.ts:85-102` | fixed field order, `type` defaulted to `other`, `locked` never written |
| `slugify`, `pageRelPath` | `…/slug.ts:30-98` | latin lowercased, CJK preserved, boundary/duplicate hyphens collapsed; `type` → directory map |
| `chunkText`, `estimateTokens` | `…/chunker.ts:70-100` | `targetChars` clamped to ≥1000, overlap clamped to floor(target/2), heading-boundary split with paragraph/hard fallbacks |

## Normalized operation result

The demo defines the deterministic document ID as:

```
doc_id = sha256(pageRelPath(type, title))[0:16]
```

`pageRelPath` itself is deterministic because `slugify` is a pure character scan.
Observed output (`out.json`):

```
locking.md             doc_id=fa54cee423152133  slug=手工锁定页      rel_path=wiki/concepts/手工锁定页.md  type=concept fm=true  locked=true   chunks=1 [124]
redis-cluster.md       doc_id=f053ae5e69a1628b  slug=redis-cluster   rel_path=wiki/entities/redis-cluster.md type=entity  fm=true  locked=false  chunks=2 [988,602]
streams.md             doc_id=097795b57eb0c5b4  slug=redis-streams   rel_path=wiki/concepts/redis-streams.md type=concept fm=true  locked=false  chunks=1 [207]
无-frontmatter-笔记.md  doc_id=8fa715fa80e02eb2  slug=无-frontmatter-笔记 rel_path=wiki/other/无-frontmatter-笔记.md type=other  fm=false locked=false chunks=1 [253]

documents=4  total_chunks=5
```

Notes on the numbers:

- `redis-cluster.md` body exceeds the 1000-char target and splits into **2
  chunks** at a markdown heading boundary; the extra 400-char overlap tail is why
  `988 + 602 = 1590` exceeds the body length.
- `无-frontmatter-笔记.md` has no `---` block, so `parseFrontmatter` falls back to
  `type="other"`, giving `wiki/other/…` and `has_frontmatter=false`.
- `locking.md` reports `locked=true`, the signal ingest uses to skip locked pages.
- Each document's `reparse_type` (in `out.json`) equals its `type`, confirming the
  `buildPage` round-trip.

## Implementation notes / limitations

- `slug.ts` and `chunker.ts` are **imported and executed as the real modules**
  (Node 24 native TypeScript type stripping; both are pure and dependency-free).
- `frontmatter.ts` imports the `yaml` package, which is **not installed** in this
  checkout (no `node_modules`) and installing dependencies was out of scope. Its
  regex block-splitting, tolerant `{type:"other"}` fallback, `isLocked` /
  `readSources` accessors, and `buildPage` field ordering are therefore mirrored
  locally in `run-demo.mjs` (`parseFrontmatterShim`, `miniYaml`, `buildPage`).
  The mirror covers the scalar / quoted-string / block-list subset used by the
  corpus; it is behavior-equivalent for these inputs but is not the upstream module.
- `vitest` is likewise unavailable, so validation is the demo run plus a
  two-run determinism diff rather than the repo's unit tests.

## Determinism statement

All inputs are files on disk, all transformations are pure functions (no clock,
no randomness, no environment reads), and the corpus is read in sorted filename
order. Output is therefore fully reproducible; two consecutive runs were diffed
and matched exactly.
