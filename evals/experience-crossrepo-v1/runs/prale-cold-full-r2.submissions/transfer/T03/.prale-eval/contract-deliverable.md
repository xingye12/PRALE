# T03 — Contract: deterministic normalization of a duplicate-heading / malformed-frontmatter corpus

- **task_id**: `T03` · **repository**: `tdam` · **mode**: `contract`
- **Executable demo**: `.prale-eval/normalize.mjs` (run: `node .prale-eval/normalize.mjs --check`)
- **Normalized operation result**: `.prale-eval/out/normalization-report.json`, `.prale-eval/out/wiki-index.md`, `.prale-eval/out/validation.json`
- **Corpus under contract**: `.prale-eval/corpus/*.md` (9 files)

## 1. What was contracted

The wiki ingestion engine of `MemoryKnowledge` is contracted against the *wiki* corpus it
was written for. This task contracts the **same normalization rules against a different
corpus**: the repository's operator/agent documentation corpus
(`docs/tdai-v2-technical-ops.md`, `agents/<agent>/asset-import.md`,
`agents/<agent>/README.md`), re-materialized as 9 fixture pages that deliberately contain

1. **duplicate headings** — both inside one file (`## 扫什么` twice in `agent-codex.md`,
   `## 主从复制` twice in `entity-redis.md`, `## 1. 客户端接入配置` twice in `ops-notes.md`)
   and *across files that merge into one normalized page* (`entity-redis.md` +
   `entity-redis-2.md` both normalize to `wiki/entities/redis-主从.md`), plus duplicate
   headings whose **raw text differs but whose slug is identical** (`## 集群模式` vs
   `## 集群模式！`);
2. **malformed frontmatter** in five distinct ways — unterminated block, invalid YAML
   (unclosed flow sequence), duplicate key, non-mapping root, and no frontmatter at all;
3. **invalid *field* metadata in otherwise valid YAML** — unknown `type: assets`, missing
   `title`, and `sources` containing non-string entries.

The demo imports the repository's real symbols — no slug logic is re-implemented:

```js
import { dirForType, pageRelPath, slugify }
  from "../MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts";
```

## 2. The contract

### 2.1 Deterministic slug normalization

`slugify()` (`MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts:30-64`) is a pure
character scanner: CJK runs are kept verbatim, latin/alnum runs are lowercased, and every
other character (space, punctuation) is a segment boundary; segments are joined with `-`
and leading/trailing/duplicated hyphens are stripped. Consequences the corpus exercises:

| raw title / heading | normalized slug | rule exercised |
|---|---|---|
| `Redis 主从` | `redis-主从` | latin lowercased + CJK preserved (`slug.ts:51-54`, `46-50`) |
| `redis-主从!` | `redis-主从` | punctuation (`!`) is a boundary, stripped (`slug.ts:55-58`) |
| `1. 客户端接入配置` | `1-客户端接入配置` | digits count as alnum, `.` becomes a boundary |
| `TDAI v2 — Technical Ops Guide (for Nick)` | `tdai-v2-technical-ops-guide-for-nick` | punctuation-only segments collapse (`slug.ts:63`) |

Because the function is pure, the demo asserts `slugify(slugify(x)) === slugify(x)` over
27 corpus-derived probes (`slugify is idempotent` check).

`dirForType()` (`slug.ts:84-87`) + `pageRelPath()` (`slug.ts:94-98`) turn
`(type, title)` into the canonical dedup key `wiki/<dir>/<slug>.md`
(`entity → entities`, `source → sources`; an unregistered type such as `assets` falls back
to the lowercased type itself, and the malformed-frontmatter fallback `other` lands in
`wiki/other/`).

### 2.2 Duplicate headings → deterministic anchors

Anchors are assigned **per normalized page**, in (corpus file path, line number) order.
The first occurrence keeps the bare slug; each later occurrence of the same slug gets
`-2`, `-3`, … So a merged page is stable regardless of which file was read first
(file order is code-point order, never `localeCompare`). Duplicates that live in
*different* pages are intentionally not renamed (anchors are page-scoped), which is why
`扫什么` stays `扫什么` in four different pages.

### 2.3 Invalid metadata is handled explicitly

The library's reader is deliberately tolerant, and this contract preserves its semantics:
`parseFrontmatter()` (`frontmatter.ts:42-62`) returns `{type:"other"}` /
`hasFrontmatter:false` for a missing or unparseable block, a non-object block, or a
non-string/empty `type`; `readSources()` (`frontmatter.ts:71-76`) keeps only string
entries. The contract layer adds what the library leaves implicit: **every rejection emits
a diagnostic with the exact fallback applied**, so nothing is dropped silently. Nothing
throws: the demo normalizes all 9 files, including the unterminated one.

| malformed input in corpus | diagnostic | explicit fallback |
|---|---|---|
| `agent-dsh.md` — opening `---` never closed | `FM_UNTERMINATED` (line 1) | whole block discarded → `type=other`, `hasFrontmatter=false`, body = whole file |
| `agent-openclaw.md` — `tags: [openclaw, session` | `FM_INVALID_YAML` (line 4) | whole block discarded → `type=other` |
| `agent-hermes.md` — `type:` declared twice | `FM_DUPLICATE_KEY` (line 4) | whole block discarded → `type=other` (yaml v2 `uniqueKeys:true` would throw) |
| `agent-workbuddy.md` — root node is a sequence | `FM_NOT_MAPPING` (line 2) | whole block discarded → `type=other` |
| `ops-notes.md` — no frontmatter at all | `FM_ABSENT` | `type=other`, `title` = basename |
| `agent-codebuddy.md` — `title` missing | `FM_TITLE_FALLBACK` | `title="agent-codebuddy"` (basename, same rule as `index-builder.ts:69-72`) |
| `agent-codebuddy.md` — `sources: [raw/...md, 42, null, true]` | `FM_SOURCES_NON_STRING` (3 dropped) | `sources=["raw/agents/codebuddy.md"]` (same filter as `readSources()`) |

## 3. Normalized operation result

Nine corpus files normalize to eight pages (one merge) with 19 diagnostics; the report
records each file's parsed frontmatter, requested/assigned path, heading anchors and
diagnostics.

| corpus file | frontmatter | type | normalized title | assigned page |
|---|---|---|---|---|
| `agent-codebuddy.md` | ok (unknown type) | `assets` | `agent-codebuddy` | `wiki/assets/agent-codebuddy.md` |
| `agent-codex.md` | ok | `source` | `Codex 资产导入` | `wiki/sources/codex-资产导入.md` |
| `agent-dsh.md` | unterminated | `other` | `agent-dsh` | `wiki/other/agent-dsh.md` |
| `agent-hermes.md` | duplicate-key | `other` | `agent-hermes` | `wiki/other/agent-hermes.md` |
| `agent-openclaw.md` | invalid-yaml | `other` | `agent-openclaw` | `wiki/other/agent-openclaw.md` |
| `agent-workbuddy.md` | not-mapping | `other` | `agent-workbuddy` | `wiki/other/agent-workbuddy.md` |
| `entity-redis-2.md` | ok | `entity` | `redis-主从!` | `wiki/entities/redis-主从.md` (collision rank 1) |
| `entity-redis.md` | ok | `entity` | `Redis 主从` | `wiki/entities/redis-主从-2.md` (collision rank 2) |
| `ops-notes.md` | absent | `other` | `ops-notes` | `wiki/other/ops-notes.md` |

Diagnostic census: `FM_ABSENT:1, FM_DUPLICATE_KEY:1, FM_INVALID_YAML:1, FM_NOT_MAPPING:1,
FM_SOURCES_NON_STRING:1, FM_TITLE_FALLBACK:6, FM_UNTERMINATED:1, HEADING_DUPLICATE:6,
PAGE_PATH_COLLISION:1` (19 total).

Duplicate-heading resolution (6 of them):

```
agent-codex.md:28   '扫什么'            -> 扫什么-2        (dup of :5)
entity-redis-2.md:13 '集群模式！'        -> 集群模式-2      (dup of :9, different raw text)
entity-redis.md:1   'Redis 主从'        -> redis-主从-2    (merged page, dup of entity-redis-2.md:1)
entity-redis.md:5   '主从复制'          -> 主从复制-2      (dup of entity-redis-2.md:5)
entity-redis.md:9   '主从复制'          -> 主从复制-3
ops-notes.md:12     '1. 客户端接入配置'  -> 1-客户端接入配置-2
```

Cross-file page collision:

```
wiki/entities/redis-主从.md      <- entity-redis-2.md (first in code-point file order)
wiki/entities/redis-主从-2.md    <- entity-redis.md  (PAGE_PATH_COLLISION, deterministic -2)
```

`out/wiki-index.md` is the rendered, ordered result (group order `sources → entities →
… → unknown types`, mirroring `index-builder.ts:86-116`).

A documented refinement over `chunker.ts:27-63` (whose heading splitter at line 32
matches `^#{1,6}\s+\S` on every line, fence-unaware): heading census here is
fence-aware, and `#` lines inside fenced code blocks are counted
(`agent-codex.md` 1, `ops-notes.md` 1) instead of being mistaken for headings.

## 4. Determinism proof

- Report/state contain no timestamp, random value or locale-dependent comparison
  (`localeCompare` is not used anywhere; ordering is code-point `<`).
- 3 fresh in-process runs of the whole pipeline produce byte-identical output.
- Two **separate processes** produce the byte-identical report:
  `sha256(normalization-report.json) = 90c759a0f47b699b9401de971328b9880f3531f406fffbd23e107d500205861a`,
  canonical state digest `a0323e7f353bcc1d352d9a0fe13da9171507bcc060a78b210b3f8a834a7eb637`,
  `sha256(wiki-index.md) = e7bb3d26b8535c4ffec29824553986b348643b7c043f16410a3e1f155c6666db`.
- `slugify` idempotent over 27 probes; anchors unique per page; malformed frontmatter
  never silently ignored (0 silent rejections, 0 rejections without `type=other`).

## 5. Validation and limitations

```
$ node .prale-eval/normalize.mjs --check   # run twice; exit code 0
[PASS] slugify is idempotent — 27 probes
[PASS] three fresh runs produce identical bytes
[PASS] cross-process determinism — canonical digest identical to previous process run
[PASS] malformed frontmatter is explicit — 5 files, 0 silent, 0 without type=other
[PASS] every diagnostic carries detail + fallback — 19 diagnostics
[PASS] anchors unique per page — 8 pages
[PASS] duplicate headings deduped deterministically — 6 duplicates
[PASS] page collisions detected and merged deterministically — wiki/entities/redis-主从.md
[PASS] report is time-free and locale-free
RESULT: PASS
```

**Limitation (recorded, not worked around):** `frontmatter.ts` imports the `yaml`
package, which is **not installed** in this workspace and must not be installed here, so
the repository's real `parseFrontmatter()` could not be executed. `resolveBackends()`
attempts the import at runtime and, on `ERR_MODULE_NOT_FOUND`, records the limitation in
the report (`backends.frontmatter.available === false`) and uses a documented YAML-subset
mirror of the same contract (bad block → `{type:"other"}`, `hasFrontmatter:false`;
`sources` filtered to strings), adding the explicit diagnostics. Everything that *can* be
executed for real — `slugify`, `dirForType`, `pageRelPath` — is imported and executed from
`slug.ts`, so the slug/path/dedup half of the contract is verified against the shipped
implementation rather than a copy. If `yaml` were installed, re-running the same command
would import the real module and cross-check the mirror.
