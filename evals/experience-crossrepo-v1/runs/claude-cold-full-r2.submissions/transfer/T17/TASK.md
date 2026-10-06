# Cross-repository experience transfer task

Repository key: `pi`
Task mode: `demo`

## Request

**Demo** for a fresh extension fixture: show that a project extension is unavailable during bootstrap and becomes available only after an explicit trusted decision.

## Required delivery

Write `.prale-eval/result.json` with this JSON object: `task_id` exactly `T17`, `repository` exactly `pi`, and `mode` exactly `demo`; also include `evidence` (a list of objects with `path`, `symbol`, `start_line`, `end_line`, and `observation`), `claims` (a list of objects with `claim` and `evidence_paths`), `conclusion`, and `validation` (with `command`, `status`, and `notes`). Also write `.prale-eval/demo-deliverable.md` describing the executable demo, contract, or normalized operation result. Do not modify task metadata, hidden-oracle files, package locks, or git configuration.

<!-- crossrepo-evidence-contract:start -->
## Required source evidence

Your `evidence` array must include one substantive entry for each of these repository-relative files:
- `packages/coding-agent/src/core/resource-loader.ts`

For each entry, name a real symbol, give an inclusive `start_line`/`end_line` range that contains that symbol, and explain its task-relevant behavior. Add at least one substantive `claims` item per required path; each claim must name the paths in its `evidence_paths`. These files are the public acceptance contract; the oracle checks that citations, symbols, line ranges and grounded claims are present.
<!-- crossrepo-evidence-contract:end -->

The acceptance oracle is hidden. Equivalent correct implementations are allowed.
