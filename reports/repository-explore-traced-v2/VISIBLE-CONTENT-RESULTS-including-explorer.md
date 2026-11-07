# Returned source-content rescore

Conservative offline attribution from retained outputs, verified against pinned source. Includes read, explorer snippets and bash-returned source lines. Excludes filename lists and internal scanning. Ambiguous output is not attributed; sets are not guaranteed exhaustive. No model calls or reruns.

| Metric (8-task macro) | Baseline | Treatment |
| --- | ---: | ---: |
| Recall | 88.55% | 88.70% |
| Weighted recall | 92.61% | 92.47% |
| Precision | 45.35% | 47.81% |

| Task | B files | B recall | B precision | T files | T recall | T precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| evaluation-and-langfuse | 27 | 93.33% | 51.85% | 32 | 100.00% | 46.88% |
| memory-design | 28 | 92.31% | 42.86% | 37 | 100.00% | 35.14% |
| memory-recovery-and-consistency | 33 | 84.62% | 33.33% | 32 | 92.31% | 37.50% |
| project-architecture | 70 | 100.00% | 27.14% | 48 | 89.47% | 35.42% |
| repository-explorer-design | 20 | 91.67% | 55.00% | 14 | 83.33% | 71.43% |
| repository-explorer-query-behavior | 7 | 80.00% | 57.14% | 5 | 80.00% | 80.00% |
| tool-effect-recovery | 28 | 87.50% | 50.00% | 32 | 75.00% | 37.50% |
| web-composition-and-config | 33 | 78.95% | 45.45% | 44 | 89.47% | 38.64% |

Full file lists and per-command evidence audits: visible-content-scores.json. Token/time/call counts remain those of the traced run.
