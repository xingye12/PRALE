# Cross-repository experience task learn/05

Repository key: `pi`
Task mode: `explore`

## Request

**Explore** model catalog generation and offline build paths (`packages/ai`, root scripts); report which inputs are generated, hydrated, and safe offline.

## Required delivery

Write `.prale-eval/result.json` with this JSON object: `task_id` exactly `05`, `repository` exactly `pi`, and `mode` exactly `explore`; also include `evidence` (a list of objects with `path`, `symbol`, `start_line`, `end_line`, and `observation`), `claims` (a list of objects with `claim` and `evidence_paths`), `conclusion`, and `validation` (with `command`, `status`, and `notes`). Do not modify task metadata, hidden-oracle files, package locks, or git configuration.

<!-- crossrepo-evidence-contract:start -->
## Required source evidence

Your `evidence` array must include one substantive entry for each of these repository-relative files:
- `packages/ai/package.json`
- `scripts/publish-model-catalog.mjs`

For each entry, name a real symbol, give an inclusive `start_line`/`end_line` range that contains that symbol, and explain its task-relevant behavior. Add at least one substantive `claims` item per required path; each claim must name the paths in its `evidence_paths`. These files are the public acceptance contract; the oracle checks that citations, symbols, line ranges and grounded claims are present.
<!-- crossrepo-evidence-contract:end -->

The acceptance oracle is hidden. Equivalent correct implementations are allowed.
