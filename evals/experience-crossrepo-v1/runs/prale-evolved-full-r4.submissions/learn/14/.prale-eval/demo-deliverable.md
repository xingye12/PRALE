# Demo deliverable — wiki-ingest helpers on a local markdown corpus (task 14)

**Mode:** `demo` · **Repository:** `tdam` · **Scope:** read-only use of `MemoryKnowledge/src/engines/wiki/ingest-v2/*`

## What is demonstrated

An executable demo that feeds a small local markdown corpus through the *real* wiki-ingest
helpers and emits deterministic document IDs and chunk counts:

| Helper | Module | Symbol |
| --- | --- | --- |
| slug / path | `MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts` | `slugify` (L30-77), `dirForType` (L84-87), `pageRelPath` (L94-97) |
| frontmatter | `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts` | `parseFrontmatter` (L42-62), `buildPage` (L85-102), `isLocked` (L65-68), `readSources` (L71-74) |
| chunker | `MemoryKnowledge/src/engines/wiki/ingest-v2/chunker.ts` | `splitIntoUnits` (L27-63), `chunkText` (L70-95), `estimateTokens` (L98-100) |

No helper logic is re-implemented: `run-demo.mjs` imports the shipped `.ts` sources directly.

## How to run

```bash
node --import ./.prale-eval/demo/register-loader.mjs ./.prale-eval/demo/run-demo.mjs
```

Artifacts:

- `.prale-eval/demo/corpus/` — 4 markdown files (small local corpus, static and versioned)
  - `long-source.md` (4192 B, 4 sections + heading, `type: source`)
  - `redis-cluster.md` (`type: entity`, block `tags` list)
  - `vector-index.md` (`type: concept`, mixed-script title `HNSW 向量索引`, flow `tags`/`sources`)
  - `plain-notes.md` (no frontmatter at all — exercises the tolerant fallback)
- `.prale-eval/demo/run-demo.mjs` — the demo entry point
- `.prale-eval/demo/loader.mjs`, `.prale-eval/demo/register-loader.mjs`, `.prale-eval/demo/yaml-shim.mjs` — module-resolution shim for the missing `yaml` dependency (see Limitations)
- `.prale-eval/demo-output.json` — the normalized operation result (written by the demo, also printed to stdout)

## Contract (normalized operation result)

For every corpus file the demo performs exactly this sequence, matching the production ingest
path: `readFileSync` → `parseFrontmatter` → title fallback (`frontmatter.title`, else file base
name, as in `index-builder.ts:collectEntries`) → `slugify` → `pageRelPath(type,title)` for the
document id → `chunkText(body, …)` → `buildPage`/`parseFrontmatter` round-trip.

Deterministic output fields per document:

```json
{
  "source": "redis-cluster.md",
  "contentId": "f3a5c6900d8d",          // sha256(content)[:12] — content fingerprint
  "hasFrontmatter": true,
  "type": "entity",
  "title": "Redis Cluster",
  "slug": "redis-cluster",
  "dir": "entities",
  "docId": "wiki/entities/redis-cluster.md",   // canonical dedup key (slug.ts pageRelPath)
  "locked": false,
  "sources": ["redis-cluster.md"],
  "bodyChars": 255,
  "estimatedTokens": 85,
  "chunkCountAtDemoTarget": 1,
  "chunkCountAtProductionBudget": 1,
  "chunkLengths": [253],
  "roundTrip": { "hasFrontmatterAfterRebuild": true, "typePreserved": true,
                 "titlePreserved": true, "tagsPreserved": true,
                 "sourcesPreserved": true, "bodyPreserved": true }
}
```

### Observed results (this run)

| source | contentId | type | title | docId | chunkCount @1000 | chunkCount @28000 | chunk lengths |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `long-source.md` | `ae7d926117fa` | source | Ingest Design Notes | `wiki/sources/ingest-design-notes.md` | 8 | 1 | `[522,901,901,901,901,901,901,901]` |
| `plain-notes.md` | `f02d805414b5` | other | plain-notes | `wiki/other/plain-notes.md` | 1 | 1 | `[254]` |
| `redis-cluster.md` | `f3a5c6900d8d` | entity | Redis Cluster | `wiki/entities/redis-cluster.md` | 1 | 1 | `[253]` |
| `vector-index.md` | `16b01ac55eaa` | concept | HNSW 向量索引 | `wiki/concepts/hnsw-向量索引.md` | 1 | 1 | `[234]` |

Totals: `documentCount = 4`, `totalChunksAtDemoTarget = 11`, `totalChunksAtProductionBudget = 4`.

Behaviors pinned by the run:

1. **Deterministic IDs.** `slugify("Redis Cluster") = "redis-cluster"`; the mixed-script title
   `HNSW 向量索引` becomes `hnsw-向量索引` (CJK preserved, latin lower-cased, space → `-`), so the
   doc id is `wiki/concepts/hnsw-向量索引.md`. Two independent runs serialize byte-identically
   (`deterministicAcrossRuns: true`).
2. **Tolerant frontmatter.** `plain-notes.md` has no `---` block → `hasFrontmatter: false`,
   `type: "other"`, full text kept as body (L44-46 of `frontmatter.ts`), and `dirForType("other")`
   falls back to `other/`.
3. **Round-trip stability.** `buildPage(parseFrontmatter(c).frontmatter, body)` re-parses to the
   same `type`/`title`/`tags`/`sources` and the same whitespace-trimmed body for all 4 documents.
4. **Chunking.** `chunkText` clamps `targetChars` to `>= 1000` (L71), so the demo target is 1000.
   `long-source.md` splits on markdown heading boundaries into 8 chunks; only the first is 522
   chars, every later chunk is 901 = 400-char overlap tail + `\n\n` + one ~499-char section, and
   each chunk is `<= target`.
5. **Production budget.** With the real `SOURCE_CHAR_BUDGET = 28_000` used by `index.ts:130-131`,
   every corpus file is a single chunk, i.e. this corpus would not be split by the real pipeline.

All embedded checks (`allChecksPassed: true`, `failedChecks: []`) are computed in-process; the
demo exits non-zero if any of them fails.

## Limitations / caveats

- **`yaml` dependency not installed.** This checkout has no `node_modules` and dependencies must
  not be installed, so `frontmatter.ts`'s bare `import { parse, stringify } from "yaml"` is
  redirected (via `loader.mjs` + `register-loader.mjs`) to a minimal local shim
  (`yaml-shim.mjs`) covering only the subset the corpus uses: flat scalars, booleans, flow
  sequences and block sequences. Frontmatter features outside that subset (anchors, nested maps,
  multi-line scalars) are **not** exercised. Everything else — the TS sources, `buildPage`'s field
  ordering/`locked` stripping, the `FM_RE` regex, all slug and chunker logic — is the shipped code.
- Node's built-in TypeScript type-stripping (`node v24.14.0`, no flags beyond `--import`) executes
  the `.ts` sources; no build step or `tsc` is required.
- The demo is offline and deterministic: no timestamps, no randomness, no filesystem writes outside
  `.prale-eval/`.
