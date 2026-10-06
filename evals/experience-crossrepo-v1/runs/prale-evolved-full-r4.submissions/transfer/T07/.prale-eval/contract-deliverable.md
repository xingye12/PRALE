# T07 contract deliverable — wiki ingest-v2 normalization over a duplicate-heading / malformed-frontmatter corpus

- **Task:** T07 · **Repository:** `tdam` · **Mode:** `contract`
- **Executable contract:** `.prale-eval/contract/normalize-corpus.mjs`
- **Static citation validator:** `.prale-eval/contract/verify-contract.mjs`
- **Corpus:** `.prale-eval/contract/corpus/` (17 markdown files, hashes in `.prale-eval/contract/corpus.sha256`)

## 1. What is being contracted

The wiki ingest-v2 engine keys dedup on a canonical page path derived from the
page **type** and **title**:

```
pageRelPath(type, title) = "wiki/" + dirForType(type) + "/" + slugify(title) + ".md"
```

Source of truth: `MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts`
(`slugify` :30-64, `TYPE_DIR` :72-81, `dirForType` :84-87, `pageRelPath` :94-98).

Because ingest is incremental, the contract that matters for a corpus is:

1. **Determinism** — the same input bytes must always produce the same canonical
   page set, regardless of ingest order or how many times it runs.
2. **Duplicate headings** — headings that differ only by case/whitespace/punctuation
   must converge to one page, and the convergence must be reported, not silent.
3. **Malformed metadata** — invalid frontmatter must be *rejected explicitly*
   (typed code + source path), never silently dropped or coerced.

## 2. The T07 corpus

| File | Intent | Expected outcome |
|---|---|---|
| `ok-01-redis-cluster.md` | `entity` / `Redis Cluster` | accepted → `wiki/entities/redis-cluster.md` |
| `ok-02-redis-cluster-spaced.md` | `entity` / `redis   cluster` | accepted → collides with ok-01 |
| `ok-03-redis-cluster-punct.md` | `entity` / `Redis-Cluster!` | accepted → collides with ok-01 |
| `ok-04-concept-redis-cluster.md` | `concept` / `Redis Cluster` | accepted → `wiki/concepts/redis-cluster.md` (type-scoped, no collision) |
| `ok-05-cjk-primary.md` | `entity` / `Redis 主从` | accepted → `wiki/entities/redis-主从.md` |
| `ok-06-cjk-lowercase.md` | `entity` / `redis 主从` | accepted → collides with ok-05 |
| `ok-07-bom-crlf.md` | BOM + CRLF, `sources: design.md` scalar | accepted, events `BOM_STRIPPED`, `CRLF_NORMALIZED`, `SCALAR_SOURCES_COERCED` |
| `ok-08-locked.md` | `locked: true` + `custom_field` | accepted, event `LOCKED_DROPPED` (locked never emitted) |
| `bad-01-missing-fm.md` | no `---` block | rejected `MISSING_FRONTMATTER` |
| `bad-02-unterminated-quote.md` | `title: "Broken` | rejected `MALFORMED_YAML` |
| `bad-03-duplicate-key.md` | `type` twice | rejected `MALFORMED_YAML` |
| `bad-04-blank-type.md` | `type: "   "` | rejected `INVALID_TYPE` |
| `bad-05-missing-title.md` | no `title` | rejected `MISSING_TITLE` |
| `bad-06-nonstring-sources.md` | `sources: [design.md, 42]` | rejected `INVALID_FIELD` |
| `bad-07-non-mapping.md` | frontmatter is a bare string | rejected `MALFORMED_YAML` |
| `bad-08-tab-indent.md` | tab-indented line | rejected `MALFORMED_YAML` |
| `bad-09-empty-slug.md` | `title: "!!!"` | rejected `EMPTY_SLUG` |

## 3. Normalized operation result

Running `node .prale-eval/contract/normalize-corpus.mjs` (exit 0):

- **Accepted 8 / rejected 9 = 17 files.** No page is unaccounted for.
- **Duplicate-heading dedup:** `wiki/entities/redis-cluster.md` is produced once,
  `mergedFrom: ["ok-01-redis-cluster.md", "ok-02-redis-cluster-spaced.md", "ok-03-redis-cluster-punct.md"]`,
  with sorted union sources `["design.md", "notes.md", "redis.md"]`.
  The collision is also emitted as an explicit record
  (`occurrenceCount: 3`, deterministic `chosen: "ok-01-redis-cluster.md"`).
- **CJK duplicate:** `wiki/entities/redis-主从.md` merges ok-05 + ok-06 — the
  characters are preserved, only the latin part is lower-cased.
- **Canonical page set:** `wiki/entities/redis-cluster.md`,
  `wiki/entities/redis-主从.md`, `wiki/entities/manual-page.md`,
  `wiki/concepts/redis-cluster.md`, `wiki/concepts/vector-index.md`.
- **Determinism:** the pipeline was re-run over 7 input orderings (sorted,
  reversed, 5 seeded shuffles) plus a repeat of the same order; all 8 outputs
  were byte-identical JSON (`pipeline_is_order_independent_deterministic`,
  `pipeline_repeat_run_identical`).

## 4. Checks executed (13/13 pass)

`slugify_is_pure_deterministic`, `equivalent_headings_collapse_to_same_slug`,
`cjk_heading_normalization_stable`, `distinct_types_do_not_collide`,
`duplicate_headings_dedupe_to_one_canonical_page`, `collision_is_reported_explicitly`,
`pipeline_is_order_independent_deterministic`, `pipeline_repeat_run_identical`,
`malformed_frontmatter_rejected_explicitly_with_codes`,
`no_silent_drops_all_rejections_typed`, `valid_pages_normalized_explicitly`,
`locked_flag_never_written_and_unknown_field_kept`,
`canonical_paths_are_slug_consistent`.

## 5. How the contract is grounded in the checkout

- `slugify`, `dirForType`, `pageRelPath` are **imported directly** from
  `MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts`. Node 24 strips the
  TypeScript types, so the real production normalization runs — no re-implementation,
  no build, no dependency install.
- `frontmatter.ts` is cited as the reason the explicit gate is needed:
  `FM_RE` (:36) anchors at offset 0 (BOM-sensitive) and `parseFrontmatter`
  (:42-62) **fails open** — missing block, YAML error, non-object result and
  blank type all degrade to `{type:"other"}` with `hasFrontmatter:false` and no
  error surfaced. `buildPage` (:85-101) supplies the canonical output shape
  (fixed field order, `locked` never written, body trimmed) that the harness
  mirrors for its emitted pages.

## 6. Explicitly recorded limitations

- There is **no `node_modules`** anywhere in this checkout and dependencies must
  not be installed. The `yaml` package is therefore unavailable, so
  `frontmatter.ts` **cannot be imported** and the repo's `vitest` suite cannot
  run. Replacement evidence of reduced strength: the harness re-implements the
  same `FM_RE` block detection plus a small deterministic YAML parser covering
  the corpus's constructs, and statically mirrors `parseFrontmatter` /
  `buildPage` semantics. This is also recorded in `result.json` → `validation.notes`.
- **Deliberate behavioral delta:** the production parser is tolerant (fail-open to
  `type:"other"`); this contract intentionally fails closed with typed rejection
  codes. That delta is the contract's contribution and is called out rather than
  hidden.
- No task metadata, hidden-oracle files, package locks, or git configuration were
  modified. Only `.prale-eval/` was created.
