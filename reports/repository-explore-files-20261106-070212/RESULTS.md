# Repository exploration full-tool evaluation

Model: `deepseek-flash`. Eight tasks, one run per condition. Annotation revision 2.
Source commit: `f384fac099fe2dc5d947d4cbebe22a0fa363f1db`.

Baseline: read/bash/edit/write. Treatment: the same plus repository_explore. Independent writable exports; network-disabled bash containers. No selective retries.

| Metric | Baseline | Treatment |
| --- | ---: | ---: |
| Completed | 5/8 | 8/8 |
| Unknown/interrupted | 3/8 | 0/8 |
| Observed content recall lower bound | 13.29% | 49.89% |
| Observed weighted content recall lower bound | 15.62% | 54.04% |
| Complete recall / precision | unavailable | unavailable |
| Total provider tokens | 6,748,437 | 6,068,590 |
| Tool calls | 284 | 253 |
| Mean item duration (seconds) | 286.10 | 251.49 |

All 16 items have partial file observability. Arbitrary bash reads are not attributed. Baseline used bash 266 times, read 17 times, write once; treatment used bash 202 times, read 44 times, explorer 7 times. No edit calls occurred. Explorer was offered in all treatment tasks but not required.

**The lower-bound gap does not establish a true recall improvement:** baseline predominantly read through unobserved bash, while explorer snippets and read calls are observable. Precision and complete paired coverage deltas are undefined. Completion and cost comparisons are descriptive, with no repeats or confidence intervals. Provider tokens include cache hits and do not represent monetary charges.

| Task | Baseline status | Baseline weighted lower bound | Treatment status | Treatment weighted lower bound |
| --- | --- | ---: | --- | ---: |
| evaluation-and-langfuse | unknown | 0.00% | completed | 72.00% |
| memory-design | unknown | 0.00% | completed | 82.14% |
| memory-recovery-and-consistency | completed | 0.00% | completed | 57.14% |
| project-architecture | completed | 33.33% | completed | 20.51% |
| repository-explorer-design | completed | 0.00% | completed | 36.36% |
| repository-explorer-query-behavior | completed | 91.67% | completed | 75.00% |
| tool-effect-recovery | completed | 0.00% | completed | 40.62% |
| web-composition-and-config | unknown | 0.00% | completed | 48.57% |

Baseline unknown tasks: memory-design, evaluation-and-langfuse, web-composition-and-config; each has error_code=interrupted. All attempts and their available evidence remain in reports.

Artifacts: baseline.json, treatment.json, file-scores.json, frozen tasks.json, run-manifest.json and run.log. Local traces contain tool inputs/outputs; no credentials are included.
