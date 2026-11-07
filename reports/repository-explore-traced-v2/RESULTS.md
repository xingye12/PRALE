# Traced repository file-access evaluation

Eight tasks × two conditions, one run per condition; deepseek-flash, annotation revision 2. Both conditions offer read/bash/edit/write; treatment also offers repository_explore.

Bash uses strace with child following and resolved descriptors. Successful readable opens are counted, including recursive-search nonmatches and Python imports. Directories, write-only opens, failed opens and outside paths are excluded. Read calls and explorer snippets are merged by repository-relative path. Counts are unique per task. These are file-access metrics, not proof that the model saw all opened contents.

| Metric (macro average) | Baseline | Treatment |
| --- | ---: | ---: |
| Recall | 98.56% | 98.68% |
| Weighted recall | 99.25% | 99.29% |
| Precision | 10.39% | 10.84% |
| Core-file recall | 100.00% | 100.00% |
| Completed | 7/8 | 7/8 |

Bash+read-only precision: baseline 10.39%, treatment 11.08%. Its recall and weighted recall equal the all-reading-source results above. Explorer adds extra non-gold accessed files to treatment, reducing its combined precision to 10.84%.

All eight tasks per condition have complete syscall/read access observations, including prior accesses in unknown-terminal tasks. Baseline web-composition-and-config and treatment evaluation-and-langfuse ended unknown/interrupted; no selective retries. The original model-visible-content metric remains partial and is distinct from the new accessed metric.

| Task | B unique files | B recall | B precision | T unique files | T recall | T precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| evaluation-and-langfuse | 207 | 100.00% | 7.25% | 204 | 100.00% | 7.35% |
| memory-design | 122 | 100.00% | 10.66% | 149 | 100.00% | 8.72% |
| memory-recovery-and-consistency | 149 | 100.00% | 8.72% | 122 | 100.00% | 10.66% |
| project-architecture | 120 | 100.00% | 15.83% | 98 | 100.00% | 19.39% |
| repository-explorer-design | 125 | 100.00% | 9.60% | 149 | 100.00% | 8.05% |
| repository-explorer-query-behavior | 149 | 100.00% | 3.36% | 149 | 100.00% | 3.36% |
| tool-effect-recovery | 138 | 93.75% | 10.87% | 122 | 100.00% | 13.11% |
| web-composition-and-config | 107 | 94.74% | 16.82% | 106 | 89.47% | 16.04% |

Interpretation: both conditions nearly saturate gold recall because broad recursive searches open most repository files. Precision is low relative to the annotated gold set, which is not exhaustive. This one-run result does not establish a statistically reliable explorer benefit.

raw-baseline.json and raw-treatment.json preserve initial collector outputs. baseline.json and treatment.json are reprojected from the retained syscall text to handle interleaved unfinished/resumed calls consistently. file-scores.json contains full per-task matches, omissions, unlabelled files and paired deltas. The frozen gold is tasks.json. Previous untraced run is retained separately and cannot be retroactively given exact syscall statistics.
