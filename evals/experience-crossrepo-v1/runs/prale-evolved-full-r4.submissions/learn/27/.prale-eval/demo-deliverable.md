# Demo deliverable — learn/27 (tdam)

**Task:** *Learn in TencentDB Agent Memory: normalize markdown/frontmatter input before indexing and reject malformed metadata.*

**Mode:** `demo`  ·  **Repository key:** `tdam`

This deliverable is an **executable demo + contract**. It shows how the
knowledge-ingest path should normalize a page's datasource key and markdown
frontmatter *before* indexing, and how it must **reject** malformed metadata
instead of storing a silently degraded page.

## 1. Executable demo

| | |
|---|---|
| Script | `.prale-eval/demo/normalize-and-validate.mjs` (dependency-free ESM) |
| Run | `node .prale-eval/demo/normalize-and-validate.mjs` |
| Exit code | `0` = all contract cases pass, `1` = at least one case failed |
| Output | JSON operation report on stdout (`cases[].outcome` = `indexed` \| `rejected`) |

Observed result of the recorded run: **10/10 cases passed** (`summary.failed = 0`).

The script is dependency-free on purpose: this checkout has no `node_modules`
(the real frontmatter parser imports the `yaml` package), so the demo mirrors
the two bounding contracts instead of importing them, and pins each mirrored
behavior to the source symbol/line range it reproduces.

## 2. Contract sources (public acceptance contract)

### `MemoryKnowledge/src/engines/code/normalize.ts`

- `normalizeRepoUrl` (L13–L35) collapses SSH (`git@host:path.git`), HTTPS
  (`https://host/path.git`) and already-normalized bare `host/path` spellings to
  the same `host/path` form with the `.git` suffix stripped. It is the
  **datasource-key normalization** that runs before indexing.
- `sourceKey` (L40–L42) turns that normalized URL plus branch into the stable
  index key `` `${normalizeRepoUrl(repo)}:${branch || "main"}` `` — the
  idempotency key for "the same repo indexed twice".

### `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts`

- `FM_RE` (L36) is the frontmatter fence regex `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/`
  — tolerant to CRLF, exactly what the normalizer must canonicalize.
- `parseFrontmatter` (L42–L62) splits a page into `frontmatter` + `body`. It is
  deliberately **tolerant**: missing/bad YAML degrades to `{ type: "other" }`
  with `hasFrontmatter: false` and never throws. That is the gap this task
  closes — a tolerant read must be paired with a strict validation gate before
  the page is allowed into the index.
- `buildPage` (L85–L101) is the canonical writer: fixed field order
  `type → title → description → sources → tags → timestamp → extras`, `type`
  defaults to `"other"`, the body is trimmed, and `locked` is **never** emitted.

## 3. Contract implemented by the demo

Operation: `normalizeAndIndexEntry({ repo, branch, markdown })` returns an
index record, or throws `MetadataError` (with a machine-readable `code`) and the
caller must refuse to index it.

Normalization (input → indexed record):

1. Strip BOM, normalize CRLF/CR → LF.
2. Require the leading `---` fence; parse the YAML subset strictly.
3. `type` is required, must be a non-empty string, and is trimmed.
4. `title` / `description` / `timestamp` are trimmed strings.
5. `sources` / `tags` are coerced to de-duplicated arrays of trimmed,
   non-empty strings.
6. Unknown fields are preserved (OKF tolerant consumption); `locked` is dropped
   exactly as `buildPage` does.
7. Re-emit canonical markdown with the fixed field order and a trimmed body.
8. Derive the index key via `sourceKey(repo, branch)` and the page path via
   `type → directory` + title slug.

Rejection codes (fail closed, no partial write):

| code | trigger |
|---|---|
| `EMPTY_REPO_URL` | blank datasource URL |
| `MISSING_FRONTMATTER` | no leading `---` block |
| `MALFORMED_YAML` | duplicate key, unterminated quote, unbalanced flow list, tab/indentation error, orphan list item |
| `INVALID_TYPE` | `type` missing, blank, or non-string |
| `INVALID_FIELD` | wrong scalar shape (`title`/`description`/`timestamp` not a string) or a non-string `sources`/`tags` entry |

## 4. Normalized operation result (recorded run)

Datasource-key normalization — all three spellings collapse to one key:

```
git@gitlab.example.com:namespace/project/repo.git
https://gitlab.example.com/namespace/project/repo.git
gitlab.example.com/namespace/project/repo
  → sourceKey = gitlab.example.com/namespace/project/repo:main
```

Page normalization — messy input page:

```
type: entity
title:   Redis Cluster
sources:
  - design.md
  - redis.md
  - design.md
tags: [cache, redis]
locked: true
custom_field: kept
body: "   Redis Cluster 使用分片。   "
```

normalized index record:

```json
{
  "sourceKey": "gitlab.example.com/namespace/project/repo:main",
  "path": "wiki/entities/redis-cluster.md",
  "frontmatter": {
    "type": "entity",
    "title": "Redis Cluster",
    "description": "Redis 主从拓扑",
    "sources": ["design.md", "redis.md"],
    "tags": ["cache", "redis"],
    "custom_field": "kept"
  },
  "hasLockedField": false
}
```

Malformed metadata is rejected with the codes in §3 (each verified by an
executable case in the demo): `MISSING_FRONTMATTER` for a page with no fence,
`MALFORMED_YAML` for a duplicate `type:` key and for an unterminated quote,
`INVALID_TYPE` for a blank `type:`, `INVALID_FIELD` for a non-string `sources`
entry, and `EMPTY_REPO_URL` for an empty repo URL.

## 5. Validation & limitations

- **Ran:** `node .prale-eval/demo/normalize-and-validate.mjs` → exit `0`,
  `summary = { total: 10, passed: 10, failed: 0 }`.
- **Limitation (recorded, not worked around):** the repository has no
  installed dependencies, so `pnpm typecheck` / `vitest run` cannot execute and
  the demo cannot import `frontmatter.ts` (which needs `yaml`). The demo is a
  dependency-free mirror plus a static citation check (`node
  .prale-eval/verify-citations.mjs`) over the cited source symbols and line
  ranges. No dependency was installed.
- No task metadata, hidden-oracle files, package locks, or git configuration
  were modified; the only added files live under `.prale-eval/`.
