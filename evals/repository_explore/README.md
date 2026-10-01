# PRALE repository exploration benchmark v1

This is a fixed, source-controlled benchmark for comparing an agent with and
without `repository_explore`.  The questions are about the repository at
commit `f384fac099fe2dc5d947d4cbebe22a0fa363f1db` (or a checkout explicitly pinned by the experiment), not a
generic agent-harness design.

`tasks.json` is the answer key.  It deliberately keeps the natural-language
reference answer, atomic facts, evidence anchors, and negative requirements
separate.  Do not expose any of them to the answering model.  Give the model
only `prompt` and `output_contract`; give the judge the answer key plus the
model output.

## Intended experiment

Run every task in both conditions, using the same pinned checkout, model,
system prompt, tool policy, decoding parameters, and repeat index.  The only
condition-specific difference should be the offered tool list:

* baseline: `read` (and, if deliberately part of the baseline, `bash`);
* treatment: the same list plus `repository_explore`.

The tasks do not require writes.  Do not make `repository_explore` a required
tool in the answer-quality score: the experiment is measuring whether it is
useful, not whether the model calls it ceremonially.  Record its calls and
returned-token estimate as secondary process metrics.

The evaluation harness supports a source-controlled snapshot input.  Dataset
items store only the portable commit identity; the runner receives the trusted
local repository path separately:

```json
{
  "input": {
    "prompt": "PRALE 的长期记忆模块是如何设计的？",
    "repository_snapshot": {"git_sha": "<40-or-64-character commit SHA>"},
    "tools": ["read", "repository_explore"]
  }
}
```

Run it with `python scripts/eval_harness.py --from-json dataset.json
--repository-root /path/to/PRALE`.  Each case receives a detached worktree at
that exact commit, makes it permission-read-only, and removes it after the
case. `input.files` and `repository_snapshot` are intentionally mutually
exclusive. When a case requests `repository_explore`, the harness composes it
against that temporary snapshot rather than the source checkout.

Langfuse requires dataset item IDs to be unique across the whole project, not
only inside a dataset. `scripts/build_repository_explore_datasets.py` therefore
prefixes each task ID with its condition (`baseline--` or `with-explorer--`);
compare paired reports by the suffix after that prefix.

## Judge protocol

Blind the judge to condition and randomize A/B display order.  First verify
the cited paths/symbols against the pinned checkout, then score the four
dimensions in `judge_rubric`, each from 0 to 4.  A contradiction listed in
`disallowed_claims` caps factual correctness at 1.  Return the requested
JSON, including concrete missing or wrong facts; do not reward verbosity.

For calibration, manually grade at least 20% of outputs and compare the human
ranking with the judge's pairwise ranking.  Preserve the task version and git
SHA with every Langfuse run.
