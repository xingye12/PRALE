# Bash-enabled repository exploration evaluation

Source: `f384fac099fe2dc5d947d4cbebe22a0fa363f1db`. Runtime: `c2d847c293931f1e65f58d9fdaf22c11cf8dec87`.
Model and judge: `deepseek-flash`. Eight tasks, one run per condition.
Both conditions used isolated network-disabled bash containers, the same
pinned source export, prompts, request defaults and concurrency four.
Baseline: read + bash. Treatment: read + bash + repository_explore.

| Metric | Baseline | Treatment |
|---|---:|---:|
| Completed | 8/8 | 8/8 |
| Mean answer score (0–4, all cases) | 3.858 | 3.90625 |
| Mean answer score (six mutually completed tasks) | 3.95833 | 3.87500 |
| Mean tool calls | 35.125 | 29.75 |
| P95 latency (seconds) | 230.543 | 229.264 |
| Provider total_tokens | 6,605,427 | 5,857,461 |
| JSON contract passed | 8/8 | 4/8 |

Explorer was called once in six treatment cases, and not called in two.
This run suggests better completion and fewer tokens/calls with explorer;
answer quality among mutually successful tasks did not improve.

Baseline memory-design and memory-recovery-and-consistency ended
unknown/interrupted without final answers. Both received zero judge scores;
they were retained, without selective retries. No manual interventions were
made in the scored isolated run. The earlier unconfined attempt was stopped
for accessing source outside the pinned workspace and is diagnostic only.

Existing token_cost_total sums overlapping usage fields; the table uses
provider total_tokens, not that metric. Token counts include cache hits and
are not monetary costs. Judge scoring used the answer key without independent
source verification or human calibration. The sample has no repeat runs or
confidence intervals.

See comparison.json for usage breakdowns, matched task IDs, image identity,
and runner hash; baseline.json, treatment.json and judge.json hold raw results.
