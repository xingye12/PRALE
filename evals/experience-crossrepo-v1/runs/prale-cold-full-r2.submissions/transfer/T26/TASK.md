# Cross-repository experience transfer task

Repository key: `pi`
Task mode: `operate`

## Request

**Operate** an offline fixture that intentionally lacks network data; choose and run the narrowest valid local check, reporting why it is offline-safe.

## Required delivery

Write `.prale-eval/result.json` with this JSON object: `task_id` exactly `T26`, `repository` exactly `pi`, and `mode` exactly `operate`; also include `evidence` (a list of objects with `path`, `symbol`, `start_line`, `end_line`, and `observation`), `claims` (a list of objects with `claim` and `evidence_paths`), `conclusion`, and `validation` (with `command`, `status`, and `notes`). Also write `.prale-eval/operate-deliverable.md` describing the executable demo, contract, or normalized operation result. Do not modify task metadata, hidden-oracle files, package locks, or git configuration.

<!-- crossrepo-evidence-contract:start -->
## Required source evidence

Your `evidence` array must include one substantive entry for each of these repository-relative files:
- `scripts/publish-model-catalog.mjs`
- `packages/ai/package.json`

For each entry, name a real symbol, give an inclusive `start_line`/`end_line` range that contains that symbol, and explain its task-relevant behavior. Add at least one substantive `claims` item per required path; each claim must name the paths in its `evidence_paths`. These files are the public acceptance contract; the oracle checks that citations, symbols, line ranges and grounded claims are present.
<!-- crossrepo-evidence-contract:end -->

The acceptance oracle is hidden. Equivalent correct implementations are allowed.
