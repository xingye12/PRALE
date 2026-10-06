# Cross-repository experience task transfer/23

Repository key: `pi`
Task mode: `demo`

## Request

**Evaluate in pi:** create a tiny local RPC/command adapter demo whose invalid input is rejected before the fake effect and uses one stable error shape.

## Required delivery

Write `.prale-eval/result.json` with this JSON object: `task_id` exactly `23`, `repository` exactly `pi`, and `mode` exactly `demo`; also include `evidence` (a list of objects with `path`, `symbol`, `start_line`, `end_line`, and `observation`), `claims` (a list of objects with `claim` and `evidence_paths`), `conclusion`, and `validation` (with `command`, `status`, and `notes`). Also write `.prale-eval/demo-deliverable.md` describing the executable demo, contract, or normalized operation result. Submit the complete executable scripts/tests and required local fixture data. `validation.command` must be one executable Bash command string (use relative workspace paths; combine required steps with &&). Run it before submitting. The controller will replay it in a copy of your final workspace with a fresh HOME, no agent memory, and a 60-second timeout, automatically archiving full stdout, stderr, exit code and timeout status. Keep replay-generated result files under `.prale-eval/`. Do not replace execution with prose or print a claimed success without checking the actual task behavior. Do not modify task metadata, hidden-oracle files, package locks, or git configuration.

<!-- crossrepo-evidence-contract:start -->
## Required source evidence

Your `evidence` array must include one substantive entry for each of these repository-relative files:
- `packages/agent/src/proxy.ts`

For each entry, name a real symbol, give an inclusive `start_line`/`end_line` range that contains that symbol, and explain its task-relevant behavior. Add at least one substantive `claims` item per required path; each claim must name the paths in its `evidence_paths`. These files are the public acceptance contract; the oracle checks that citations, symbols, line ranges and grounded claims are present.
<!-- crossrepo-evidence-contract:end -->

The acceptance oracle is hidden. Equivalent correct implementations are allowed.
