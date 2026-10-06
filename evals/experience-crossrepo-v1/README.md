# Cross-repository continual-experience evaluation

This directory evaluates continual experience across Pi, Aider, TencentDB
Agent Memory, and WattClaw. It measures 30 sequential learning turns followed
by a frozen-state, 30-task blinded transfer set.

## State protocol

```text
live state (30 learning tasks) → frozen snapshot S* → 30 independent S* forks
```

At freeze time the controller creates and persists a shuffled transfer plan.
Each transfer workspace receives only an opaque public stage token (`T01` …
`T30`), not the learning-pair ID. The internal token-to-task mapping is kept
in the frozen manifest and final report, outside the agent workspace. Pass
`--transfer-seed` to make a repetition reproducible; otherwise a fresh random
seed is generated and recorded at freeze time.

PRALE uses one SQLite memory database during learning. L1/L2 remain scoped to
the canonical repository ID, while L3 is shared. Transfer forks do not promote
or persist new memory. Claude Code's formal condition uses its native
per-project auto memory in a fresh session for every stage; it never resumes a
learning chat. `--claude-experience resume` remains available only as an
explicit raw-history control, not as the Claude Code native-memory result.

## Artifacts

- `TASKSET.md`: pre-registered 30 learning/transfer pairs and acceptance model.
- `task-manifest.json`: machine-readable repository, mode, and pairing data.
- `capsules/`: committed-source archives. They intentionally exclude dirty
  source worktree changes.
- `fixtures/`: 60 ready, generated task prompts, public source-evidence
  contracts, metadata, and workspace-external hidden oracles.
- [`scripts/build_crossrepo_experience_fixtures.py`](../../scripts/build_crossrepo_experience_fixtures.py):
  regenerates task prompts from the registered task set.
- [`scripts/materialize_crossrepo_oracles.py`](../../scripts/materialize_crossrepo_oracles.py):
  materializes the reviewed oracle and marks each fixture ready.

A controller accepts only stages whose metadata says `"status": "ready"`.
Each ready stage requires the agent to cite the declared real source files,
provide substantive symbol-level observations with line ranges, connect each
claim to cited evidence paths, and record validation. Demo, contract, and
operation tasks also require a deliverable. The hidden oracle rejects missing,
out-of-range, or symbol-free citations and incomplete claims. This is a
grounding/compliance gate, not a semantic-quality score: a future reviewed
task-specific rubric must separately score whether the cited code actually
supports each claim.

## Controller-captured execution evidence

For every non-explore task, submit complete executable scripts/tests and local
fixtures. `validation.command` must be a runnable Bash command using workspace-relative
paths (combine required steps with `&&`), not a prose description. Run it before
submitting. After structural acceptance, the controller replays it in a separate
copy of the final workspace with fresh HOME/TMPDIR and a 60-second timeout.
The replay follows the existing container/host-execution policy; copying a
workspace alone does not enforce network isolation. Replay must not require
agent memory or the original absolute temporary path.

Each archive adds an `execution/` directory:

```text
execution/
  execution.json   # controller command/status/exit/timeout/duration and stream hashes
  stdout.txt       # complete raw stdout, without the agent-output tail limit
  stderr.txt       # complete raw stderr
  artifacts/      # replay .prale-eval contents, separate from the original submission
```

Put replay-generated machine-readable results under `.prale-eval/`. Original
submission files, cited sources and diff are preserved before replay. Stage
reports expose execution metadata separately from structural acceptance.

The judge reads complete submitted code/delivery, workspace diff, cited sources,
captured streams and replay artifacts. It checks the capture hashes and scores
whether meaningful assertions/actions meet the objective; exit 0 or printed
success alone is insufficient. Missing or incomplete replay gives non-explore
tasks zero validation credit and cannot yield a quality pass. Expected failure
exits can be legitimate when the objective requires them. Historical archives
without capture are explicitly unverified; use new runs for this protocol.
Input is not silently truncated; a judge context-limit error requires choosing
a model with sufficient context rather than scoring partial evidence.

See [execution protocol and ADR](../../specs/crossrepo-execution-evidence.md).

Before the temporary workspace is removed, the controller archives each
submission below `runs/<report>.submissions/<phase>/<stage>/`. An archive
contains `.prale-eval/`, the exact task prompt, the complete workspace diff,
and a manifest with hashes and acceptance state. Do not use a structural
oracle pass rate as a final-output-quality rate; report the two separately.

## Controller

After all stages are marked ready, run one condition as:

```bash
python scripts/run_crossrepo_experience_eval.py \
  --adapter prale \
  --state-dir .eval-state/crossrepo/prale-evolved-r1 \
  --output evals/experience-crossrepo-v1/runs/prale-evolved-r1.json \
  --model deepseek-flash \
  --allow-host-execution
```

The same command with `--adapter claude-code` uses a continuing Claude session
for learning and independent `--resume` forks for transfer. It accepts
`--max-budget-usd`, whose default is 10 USD per stage.

Run the three phases separately when inspecting or recovering a lengthy run:

```bash
# --phase learn
# --phase freeze
# --phase transfer
```

Run the cold control directly against all 30 transfer tasks, with neither
learning state nor a resumed Claude session:

```bash
python scripts/run_crossrepo_experience_eval.py \
  --adapter prale \
  --phase cold-transfer \
  --state-dir .eval-state/crossrepo/prale-cold-r1 \
  --output evals/experience-crossrepo-v1/runs/prale-cold-r1.json \
  --model deepseek-flash \
  --allow-host-execution
```

Use the same command with `--adapter claude-code` for `Claude-fresh`. Each
transfer task receives an independent empty state; no state snapshot is made
or read. `--task-ids 01,02` is available for a paid smoke test, while omitting
it runs all 30 tasks.

The controller records stage wall time, tool calls, model turns, token usage,
and cost. Claude Code reports cost directly. The PRALE OpenAI-compatible
provider reports usage; it reports direct cost when the API supplies it. When
the API does not supply cost, set model-specific rates explicitly, for example
`--input-price-usd-per-million`, `--cache-read-price-usd-per-million`, and
`--output-price-usd-per-million`; otherwise PRALE cost remains `null` rather
than being guessed.

The controller refuses to overwrite a frozen state or transfer fork. Use a new
state directory for every repetition and system condition.

Summarize matching controller reports with:

```bash
python scripts/report_crossrepo_experience_eval.py \
  --input evals/experience-crossrepo-v1/runs/prale-evolved-r1.json \
  --input evals/experience-crossrepo-v1/runs/claude-evolved-r1.json \
  --output evals/experience-crossrepo-v1/runs/summary-r1.json
```

## Independent quality judge

After a run made with submission archiving, score only deterministic-oracle
passes with the independent judge. The judge receives no adapter or condition
label; it sees the archived task, result, full executable delivery, diff, cited source
files, controller-captured execution, and the registered rubric. It assigns 0--10 across evidence accuracy
(4), objective coverage (4), and validation/delivery (2). A quality pass needs
at least 7 total and every criterion's minimum score.

```bash
export JUDGE_API_KEY='...'
python scripts/judge_crossrepo_submissions.py \
  --input evals/experience-crossrepo-v1/runs/prale-evolved-r2.json \
  --output evals/experience-crossrepo-v1/runs/prale-evolved-r2.quality.json \
  --model deepseek-flash
```

[`quality-rubrics.json`](quality-rubrics.json) contains the 60 registered
stage rubrics. Regenerate it from the reviewed task prompts with
`scripts/build_crossrepo_quality_rubrics.py`; review changes before a formal
run because the rubric objective is task-specific and must remain frozen with
the benchmark.
