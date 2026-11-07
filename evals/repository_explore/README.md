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

## File relevance annotations v2

`tasks.json` also contains an answer-key-only `file_annotation_policy` and a
`relevant_files` list for each task. These annotations were checked against
the pinned source commit, not the current checkout or either condition's
answers. Each entry records a repository-relative `path`, integer `weight`,
verifiable `anchors` (symbols or text fragments), and a Chinese `reason`
explaining its contribution to the question.

Weights are task-specific: **3** is core evidence, **2** is directly related
implementation, contract, configuration or verification, and **1** is
supporting documentation, examples or tests. All three levels are relevant.
The list describes evidence coverage, not a unique minimum reading plan;
reading every supporting file is not necessary to answer correctly. An anchor
identifies useful content within a file; the annotation does not require a
full-file read. Runtime claims should be checked against implementation,
because historical documentation and tests can lag implementation.

| Task | Weight 3 | Weight 2 | Weight 1 | Files | Total weight |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory-design | 5 | 5 | 3 | 13 | 28 |
| memory-recovery-and-consistency | 4 | 7 | 2 | 13 | 28 |
| repository-explorer-design | 1 | 8 | 3 | 12 | 22 |
| tool-effect-recovery | 4 | 8 | 4 | 16 | 32 |
| project-architecture | 5 | 10 | 4 | 19 | 39 |
| evaluation-and-langfuse | 3 | 4 | 8 | 15 | 25 |
| web-composition-and-config | 4 | 8 | 7 | 19 | 35 |
| repository-explorer-query-behavior | 3 | 1 | 1 | 5 | 12 |

Revision 2 adds extraction/configuration evidence for memory, provider wire
serialization for explorer budgets, concrete built-in replay policies, domain
and tool contracts, Langfuse exporter/trace verification, and Web worker and
launcher lifecycle evidence. Explorer settings/composition files now have
weight 2: they establish wiring, while the indexer/tool implementation is the
core behavioral evidence. Query-behavior labels remain unchanged after review.
All added anchors were checked against the same pinned commit.

Annotation versions 1 and 2 use the same entry schema but different label
sets/weights. Do not compare scores across revisions or reuse an old report's
answer-key hash as if it described revision 2. Historical reports are retained;
recompute both conditions together from compatible access records when needed.

The annotations are deliberately broader than the original `evidence_anchors`:
for example, memory consistency includes the actual SQLite deduplication and
lease implementation, and tool recovery points to `runtime/drive.py` and
`test_span_boundaries.py`. `runtime/tools.py` defines the tool protocol and
registry; `test_effect_boundaries.py` covers a provider interruption rather
than the safe/never tool scenarios.

The evaluation question about `input.files` describes the **pinned commit**.
Snapshot support in the current runner does not change that historical answer
or the files relevant to it. Likewise, query-behavior annotations distinguish
stat/manifest index cache reuse from content-hash checks on rendered snippets;
they do not imply a whole-repository atomic snapshot.

The label set is not claimed to be exhaustive. Before using unlisted accesses
as precision penalties, review them for legitimate alternative evidence and
version any label changes consistently across both conditions. For weighted
recall, the denominator is the sum of the annotated file weights; repeated
accesses to one path count once. Report core-file coverage separately if a
metric should exclude supporting material.

The labels themselves do not collect accesses or replace the answer judge.
File-access scoring must distinguish paths returned for navigation
from files whose content/snippets were actually returned to the model.
Internal index scans, request arguments and final-answer citations are not
proof of content access. Existing reports without tool inputs/outputs cannot
be scored reliably from these labels alone.

Keep all labels, weights, anchors and reasons out of answering-model inputs.
The dataset builder selects prompt/contract fields explicitly and does not
copy the answer key into generated cases. The files remain pinned to the
historical commit, before these annotations existed.

## File-coverage experiment

The primary experiment gives both conditions `read,bash,edit,write`; treatment
also receives `repository_explore`. Each case gets an independent writable
export of the same pinned source commit:

```sh
PRALE_API_KEY=... python scripts/run_repository_explore.py \
  --output-dir reports/repository-explore-files
```

Install the explorer optional extra and build the Docker image described
below before the default run. Bash executes in a network-disabled container;
read/edit/write are confined to its mounted export, leaving the source checkout
untouched. `--read-only` reproduces the earlier read versus read+explorer
experiment without Docker. `--with-bash` remains a compatibility alias for
the default full tool set. The runner also accepts
`--tasks`, `--repository-root`, `--api-key-file`, `--model`, `--base-url` and
`--max-concurrency`. Both conditions receive the same task/answer contract
and pinned source export. Labels stay outside the workspace and model input.

The runner checkpoints `baseline.json` and `treatment.json` after each item,
then writes `file-scores.json` in a separate output directory. Each item retains
versioned `file_access` with `located_files`, `content_files`, a completeness
flag, unobserved-call reasons, and the full committed `tool_trace` (arguments,
outputs, call IDs, attempts and timestamps). No uploads occur. These traces
survive deletion of temporary Sessions. The old bash runner also saves this
evidence and file scores for future runs.

Recompute the paired scores offline without an API key:

```sh
python scripts/score_repository_explore.py \
  --baseline reports/repository-explore-files/baseline.json \
  --treatment reports/repository-explore-files/treatment.json \
  --output reports/repository-explore-files/file-scores.json
```

Reports record source SHA, annotation revision and answer-key hash. The scorer
rejects mismatches, duplicate task IDs and different paired task sets. Tasks
missing from both conditions are listed explicitly. Annotation revisions 1
and 2 share a schema; scores from different revisions must not be compared.

For each access set, `recall` is matched file count divided by labelled file
count; `weighted_recall` is matched weight divided by total labelled weight;
`precision` is matched file count divided by accessed file count; `core_recall`
covers weight-3 files only. Accesses are deduplicated. Zero accesses gives
recall zero and precision `null` (undefined). Precision remains provisional
until unlabelled accesses are reviewed. Each score lists matched, missed and
unlabelled files. Summary metrics are macro averages with observation counts;
paired deltas are treatment minus baseline on jointly observed tasks.
Unsuccessful tasks remain in the report with available access evidence.

Successful read results count as content unless truncation returns no source
lines. Explorer file headings/candidates and explicit omitted candidates count
as located paths; only actual numbered snippets count as content. Its internal
scan and known/focus path arguments do not count. Snippets are not scanned for
arbitrary path mentions or fake Markdown headings.

Successful write/edit calls record `modified_files` and their full results;
they do not count as file reads. Mutation runs are partial because the
workspace may no longer match the annotated source. Arbitrary bash commands
cannot be attributed accurately from command text or stdout. Items with
mutations, shell effects or unknown tool outcomes have partial
coverage: normal recall/precision are `null`; `recall_lower_bound` and
`weighted_recall_lower_bound` describe observed evidence only. Reports lacking
`file_access` have status `not_observed`, rather than zero accesses.

Costs include tool count, duration, provider `total_tokens`, returned bytes,
and estimated returned tokens (`ceil(JSON UTF-8 bytes/3)` per attempt).
Overlapping provider usage fields are not summed. The runner imposes no new
exploration budget; use the same provider settings and inspect costs alongside
coverage. The LLM answer judge remains available as an auxiliary evaluation.

## Intended experiment

Run every task in both conditions, using the same pinned checkout, model,
system prompt, tool policy, decoding parameters, and repeat index.  The only
condition-specific difference should be the offered tool list:

* baseline: `read,bash,edit,write`;
* treatment: the same list plus `repository_explore`.

The explicit `--read-only` compatibility mode narrows the common list to `read`.
Historical generated snapshot datasets also remain read-only; use the export
runner for the full-tool experiment, not the standard snapshot runner.

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

## Bash-enabled paired experiment

The standard `repository_snapshot` runner refuses `bash`, because it can
modify a workspace. Use the separate isolated export runner for a bash run:

```sh
docker build -t prale-eval/repository-explore-bash:v1 \
  -f evals/repository_explore/bash.Dockerfile .
PRALE_API_KEY=... python scripts/run_repository_explore_bash.py \
  --output-dir reports/repository-explore-bash
python scripts/judge_repository_explore.py \
  --baseline reports/repository-explore-bash/baseline.json \
  --treatment reports/repository-explore-bash/treatment.json \
  --output reports/repository-explore-bash/judge.json
```

The runner also accepts `--api-key-file PATH`. It exports the answer key's
pinned commit into a fresh writable directory per case, then uses the same
Harness, Drive, provider, tool schemas and scoring functions as eval_harness.
It does not change the standard snapshot policy. Baseline receives
`read,bash,edit,write`; treatment receives
`read,bash,edit,write,repository_explore`. Both receive
the same instruction to explore only the current repository using relative
paths. No answer key is added to the workspace or prompt.

Bash executes in a separate Docker container per case, with only that case's
workspace mounted at `/workspace`, no host project/configuration mounts, no
network, dropped capabilities, and a 60-second maximum per command. The image
includes common search tools, Git and Python. Read, edit, write and explorer
access the same exported files through their existing workspace confinement. Reports
record the image name and timeout. Containers are removed after each case.

Both conditions use `deepseek-flash` by default and identical provider defaults
(180-second request timeout). Cases are interleaved with shared concurrency
four. Reports are saved after each completed case, record runtime and source
commit identities, and use no Langfuse uploads. This is one run per condition,
without statistical confidence estimates. Compare the isolated paired reports
directly; older read-only reports have different tool and execution policies.
Any unconfined diagnostic run must be kept separate from the scored results.

## System-call file access scoring

The current full-tool runner uses image `prale-eval/repository-explore-bash:v2-traced`.
Build it from `bash.Dockerfile`. Bash runs under strace with child-process
following and resolved descriptor paths. Successful readable opens of regular
workspace files count, even if grep finds no match or a pipeline truncates output.
Directory listings, failed opens, write-only opens and outside paths do not count.
Raw traces are retained locally, never added to model tool messages.

`read_bash_files` deduplicates bash and read accesses. Primary `accessed_files`
also includes explorer snippets, so both conditions use the same access unit.
Scores are in `read_bash` and `accessed`; the original `content` and `located`
metrics remain separate. Trace completeness controls whether full metrics are
available. Old runs cannot be upgraded without actual system-call evidence.
File access is distinct from content delivery: these scores intentionally count
all files actually opened for reading, including recursive-search nonmatches.
