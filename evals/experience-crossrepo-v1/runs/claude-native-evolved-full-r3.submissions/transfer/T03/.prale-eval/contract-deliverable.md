# Contract deliverable — ingest normalization over a corpus with duplicate headings and malformed frontmatter

Repository: `tdam` · Mode: `contract` · Task: `T03`

This document is the human-readable contract for an **executable demo**. The demo runs the
repository's real normalization code — no re-implementation — over a synthetic corpus that is
deliberately adversarial in two ways: it repeats the same heading in many surface forms, and it
contains every class of malformed page metadata the ingest layer must survive.

## 1. Corpus contracted

The corpus is defined in [`.prale-eval/demo/corpus.mjs`](demo/corpus.mjs) — 13 pages of an
observability-runbook bundle (unrelated to this repo's own wiki fixtures):

| Group | Pages | Property |
|---|---|---|
| Duplicate headings A | `runbook-a1..a5` | one entity ("Redis 主从复制") written 5 ways: case, doubled spaces, trailing `!`, CJK/Latin hyphen, surrounding whitespace, and one with **no frontmatter** |
| Duplicate headings B | `runbook-b1`, `runbook-b2` | "Kafka Consumer Lag" with messy whitespace |
| Malformed frontmatter | `bad-nofm`, `bad-flow`, `bad-line` | missing `---` block / unterminated flow sequence / non-mapping line |
| Malformed metadata | `bad-typenum`, `bad-typeblank` | `type: 123` (non-string), `type: "   "` (blank) |
| Unknown-but-valid metadata | `unknown-type` | `type: playbook` (never seen by the type→dir map) |

## 2. The contract

Normalization is the composition of two real functions:

- `slugify(title)` — `MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts:30-64`. Deterministic
  per-character scan: Latin/digit runs lower-cased, CJK runs preserved verbatim, every other
  character is a segment boundary, segments joined with `-`, then duplicate/edge hyphens stripped.
- `pageRelPath(type, title)` — `slug.ts:94-98`, which pairs `slugify(title)` with
  `dirForType(type)` (`slug.ts:84-87`, table at `slug.ts:72-81`).

Contract clauses proven by the demo:

1. **Determinism** — the same corpus always yields a byte-identical manifest; the result does not
   depend on input order; `slugify` is a pure function.
2. **Duplicate headings collapse** — surface variants of one heading normalize to a single slug
   (the dedup key). With equivalent valid `type` metadata they also resolve to one page path, so a
   second ingest hits the existing `wiki/<dir>/<slug>.md` and merges instead of creating a new file.
3. **Invalid metadata is handled explicitly, never by throwing** — missing or unparseable
   frontmatter and non-string/blank `type` all resolve to the sentinel type `"other"`, which
   `dirForType` maps to the explicit `wiki/other/` directory; `parseFrontmatter` reports *which*
   case occurred via `hasFrontmatter`.
4. **Unknown-but-valid metadata is preserved** — a well-formed unseen type is kept, not falsely
   coerced to `other` (no over-eager fallback).

## 3. Normalized operation result

`node --import ./.prale-eval/demo/register.mjs ./.prale-eval/demo/normalize-contract.mjs`
(exits `0` = contract holds; full machine-readable manifest is printed to stdout).

```
corpusSize       13
manifestDigest   0c2b79e65d209a41a409e96d872e7e67b6eb41a7563e7305c848710db555808c
checks           PASS
failures         []
```

Duplicate headings collapse (by slug / by page path):

```
redis-主从复制        <- runbook-a1, a2, a3, a4, a5        (one slug, 5 surface forms)
kafka-consumer-lag   <- runbook-b1, b2
wiki/entities/redis-主从复制.md    <- a1, a2, a3, a5        (valid type:entity members)
wiki/concepts/kafka-consumer-lag.md <- b1, b2
```

Explicit invalid-metadata handling (excerpt of the manifest):

| id | frontmatter present | resolved `type` | resolved path |
|---|---|---|---|
| `bad-nofm` | `false` | `other` | `wiki/other/bare-procedure.md` |
| `bad-flow` | `false` | `other` | `wiki/other/broken-tags.md` |
| `bad-line` | `false` | `other` | `wiki/other/garbage-header.md` |
| `bad-typenum` | `true` | `other` | `wiki/other/numeric-type.md` |
| `bad-typeblank` | `true` | `other` | `wiki/other/blank-type.md` |
| `unknown-type` | `true` | `playbook` | `wiki/playbook/playbook-foo.md` |

The `runbook-a4` row is the clearest illustration of clause 2 + 3 interacting: its heading is a
duplicate of group A, so it shares the slug `redis-主从复制`, but because its frontmatter is
missing, `type` falls back to `other` and it lands in `wiki/other/` rather than `wiki/entities/`.
Duplicate-heading dedup is therefore keyed on the slug; the directory is a function of the
(explicitly defaulted) type.

## 4. Determinism evidence

The manifest digest was identical across three independent `node` processes:

```
0c2b79e65d209a41a409e96d872e7e67b6eb41a7563e7305c848710db555808c
0c2b79e65d209a41a409e96d872e7e67b6eb41a7563e7305c848710db555808c
0c2b79e65d209a41a409e96d872e7e67b6eb41a7563e7305c848710db555808c
```

In-process, the demo also re-runs the pipeline and reverses the input order; both reproduce the
same per-page identities.

## 5. Validation & limitation

- **Command:** `node --import ./.prale-eval/demo/register.mjs ./.prale-eval/demo/normalize-contract.mjs`
- **Result:** `checks: PASS`, exit code `0`, digest stable across processes.
- **Limitation (recorded deliberately):** the repo's declared test runner (`vitest`) and runtime
  (`tsx`) are **not installed** (`node_modules` is absent) and dependencies must not be installed
  here, so the demo is driven by Node's built-in TypeScript type-stripping (Node v24.14.0) instead.
  `slug.ts` has no imports and runs directly. `frontmatter.ts` imports the third-party `yaml`
  package, which is unavailable; to execute its **real** code paths the demo maps that specifier to
  a small, clearly-labelled test double (`.prale-eval/demo/yaml-shim.mjs`) via a Node
  module-resolution hook (`.prale-eval/demo/hooks.mjs`). The double is strict and throws on
  malformed YAML — exactly the behaviour `parseFrontmatter`'s `try/catch` (`frontmatter.ts:51-58`)
  guards — so the invalid-metadata conclusions rest on the repository's real fallback logic, not on
  the double. The double is demo scaffolding only and is never imported by repository code.
- **No repository source, task metadata, lockfile, or git configuration was modified.**
