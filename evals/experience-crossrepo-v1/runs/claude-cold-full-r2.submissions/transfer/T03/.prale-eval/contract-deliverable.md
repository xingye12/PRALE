# T03 — Contract deliverable: deterministic normalization + explicit invalid-metadata handling

Repository: `tdam` · Mode: `contract` · Task: `T03`

This deliverable **contracts a corpus that is not the repository's own docs** —
seven short succulent-care notes (`.prale-eval/corpus/*.md`) that deliberately
contain duplicate headings and several flavours of malformed frontmatter — and
runs the repository's own normalization primitives over it to prove two
properties: normalization is **deterministic**, and invalid metadata is handled
**explicitly** (reported as a typed diagnostic) rather than silently accepted or
silently dropped.

## How to run

```bash
node .prale-eval/normalize-corpus.ts     # exit 0 = every assertion held
```

No build step and no installed dependencies are required: Node ≥ 22.18 strips
types natively, and `MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts` — the
module under contract — has no third-party imports, so it is imported directly
by the demo. Output is written to `.prale-eval/normalized-report.json`.

## The corpus (`.prale-eval/corpus/`)

| File | Deliberate defect | Normalizes to |
| --- | --- | --- |
| `01-aloe-vera.md` | duplicate `# Overview` heading | `wiki/entities/aloe-vera.md` |
| `02-aloe--vera-dupe.md` | `sources:` is a scalar, not a list | `wiki/entities/aloe-vera.md` (merged) |
| `03-succulents.md` | no frontmatter at all | `wiki/other/succulent-overview.md` |
| `04-root-rot.md` | malformed YAML (unterminated `[...`), blank `type` | `wiki/other/root-rot.md` |
| `05-watering.md` | `type: 42`, `locked: "true"` | `wiki/other/watering-schedule.md` |
| `06-grafting.md` | opening `---` fence never closed | `wiki/other/grafting.md` |
| `07-compost.md` | `type:` present but blank, no `title` | `wiki/other/compost.md` |

## The contract

The demo pins these rules, each traceable to the repository module named:

1. **Title → slug is a pure function** (`slug.ts:30-64`, `slugify`). ASCII is
   lowercased, spaces/punctuation become segment boundaries, runs of `-` are
   collapsed, and CJK is preserved rather than romanized. Verified by the corpus:
   `"Aloe Vera"` and `"aloe  vera!"` both normalize to `aloe-vera`.
2. **Slug → page path is a pure function of (type, title)** (`slug.ts:94-98`,
   `pageRelPath`; directories from `slug.ts:84-87`, `dirForType`; table at
   `slug.ts:72-81`). Two documents resolving to the same path are a *dedup hit*,
   not a collision: they collapse onto one page with the union of their sources —
   exactly the merge contract in `merge.ts:70-109` / `unionSources`
   (`merge.ts:37-43`). The corpus exercises this: documents 01 and 02 both land
   on `wiki/entities/aloe-vera.md` (`mergedDocuments: 2`).
3. **Normalization is idempotent.** For every produced slug and every section
   anchor, `slugify(slugify(x)) === slugify(x)`.
4. **Duplicate headings get stable ordinal anchors.** Repeated heading text in
   one document is anchored `overview`, `overview-2`, … in document order, so
   repeated headings never overwrite one another. The heading splitter mirrors
   `chunker.ts:32` (`/^#{1,6}\s+\S/`).
5. **Invalid metadata is reported, never silently absorbed.** Frontmatter that
   fails to parse is downgraded to `type:"other"` exactly as
   `frontmatter.ts:42-62` does (the downgrade is that module's documented
   tolerant behaviour, including the `type` fold at `frontmatter.ts:60`); the
   difference this contract adds is that each downgrade emits a typed
   diagnostic instead of vanishing.

### Diagnostic codes (all asserted to fire)

| Code | Meaning | Tolerant outcome |
| --- | --- | --- |
| `NO_FRONTMATTER` | document opens with body text | `type:"other"`, whole text is body |
| `UNTERMINATED_FRONTMATTER` | opening `---` has no closing fence | `type:"other"`, whole text is body |
| `YAML_PARSE_ERROR` | block does not parse | `type:"other"`, `hasFrontmatter:false` |
| `TYPE_ABSENT` | no `type` key | fall back to `"other"` |
| `TYPE_EMPTY` | `type:` present, no value | fall back to `"other"` |
| `TYPE_NOT_STRING` | `type: 42` | fall back to `"other"` |
| `SOURCES_NOT_ARRAY` | `sources` is a scalar | treated as `[]` (`frontmatter.ts:71-76`) |
| `LOCKED_NOT_BOOLEAN` | `locked: "true"` (string) | **not** locked — strict `=== true` (`frontmatter.ts:65-68`) |
| `TITLE_MISSING` | no usable `title` | derived from first heading, else file name |
| `DUPLICATE_HEADING` | heading text repeats | ordinal-suffixed anchor |

The `LOCKED_NOT_BOOLEAN` row is the sharpest case: the tolerant path must not
*guess* `"true"` means locked, because treating an unparseable lock flag as
`true` would silently protect a page the user never locked — so the contract
degrades to `false` and says so out loud.

## Normalized operation result

```
corpus: 7 documents -> 6 normalized wiki pages
canonical sha256: 5274fe8f4ef02ae92621d030e637e6a8189e8e278c269da77049651521d3f12e
  repeat match=true, order-independent=true, idempotent=true
diagnostics: 19 (all 10 expected codes fired)

normalized pages:
  wiki/entities/aloe-vera.md        <- 01-aloe-vera.md, 02-aloe--vera-dupe.md
  wiki/other/compost.md             <- 07-compost.md
  wiki/other/grafting.md            <- 06-grafting.md
  wiki/other/root-rot.md            <- 04-root-rot.md
  wiki/other/succulent-overview.md  <- 03-succulents.md
  wiki/other/watering-schedule.md   <- 05-watering.md
```

### Determinism proof

The demo builds the normalized report **five times**: twice in the corpus's
file order, and three times over seeded shuffles of the input order
(mulberry32 seeds `1`, `7`, `20261003`). Documents, entities and diagnostics are
each sorted canonically (entity list by path, diagnostics by `file`+`code`+`detail`)
before hashing, and the runs' informational `order` label is excluded from the
hashed payload. All five canonical SHA-256 digests are identical:

```
5274fe8f4ef02ae92621d030e637e6a8189e8e278c269da77049651521d3f12e
5274fe8f4ef02ae92621d030e637e6a8189e8e278c269da77049651521d3f12e
5274fe8f4ef02ae92621d030e637e6a8189e8e278c269da77049651521d3f12e
5274fe8f4ef02ae92621d030e637e6a8189e8e278c269da77049651521d3f12e
5274fe8f4ef02ae92621d030e637e6a8189e8e278c269da77049651521d3f12e
```

Idempotence held for all 7 slugs, 6 page paths and 18 section anchors
(`nonIdempotent: []`). The demo exits non-zero if any of these checks, the
duplicate-heading exercise, the cross-document merge, or the "all expected
diagnostic codes fired" assertion fails, so `EXIT=0` is the contract's pass
signal rather than a human's reading of the log.

## Recorded limitation

The repository's `frontmatter.ts` imports the `yaml` package. Dependencies are
not installed in this checkout and must not be installed, so `frontmatter.ts`
was **not executed**. The tolerant frontmatter contract above is re-implemented
in the demo over a documented minimal YAML subset (flat `key: value`,
`key:` → null, `key: [a, b]`); it reproduces the observable behaviour of
`frontmatter.ts:42-76` — fence split via `FM_RE` (`frontmatter.ts:36`),
parse-failure downgrade, non-empty-string `type` fallback, `sources` array
requirement, strict `locked === true` — but it is not a substitute for running
that module against the real `yaml` parser. The module under the acceptance
contract, `slug.ts`, *is* the real file, imported and executed verbatim.
