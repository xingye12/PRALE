# Real-v3

24 repository repair tasks: 12 basic (`fixtures/`) and 12 advanced
(`advanced/fixtures/`). Fault injection adds no explanatory source comments.
Deleted checks are removed outright. Original source comments remain.
V2 is retained; v3 has its own benchmark ID and fixture revision 1.

Generate/check:

```sh
python scripts/build_real_experience_v3.py
python scripts/build_real_experience_v3.py --check
```

Run basic tasks (add your model/provider configuration):

```sh
python scripts/run_real_experience_batch.py \
  --capsule evals/experience-real-v3/capsules/pi-b455975/capsule.json \
  --fixtures evals/experience-real-v3/fixtures \
  --adapter prale --memory-mode warm \
  --state-dir .eval-state/real-v3-basic-warm \
  --output reports/real-v3-basic-warm.json \
  --allow-host-execution
```

For advanced tasks change `--fixtures` to `evals/experience-real-v3/advanced/fixtures`
and use separate state/output paths. For cold change `--memory-mode cold` and use
fresh state/output paths. Do not reuse v2 memory for a fresh v3 comparison.
Host execution is an operator mode, not a filesystem security sandbox.
The capsule manifest references the existing immutable v2 source archive.

Acceptance and limits: [protocol](../../specs/real-v3-comment-free-injection.md).

The PRALE adapter masks the repository `.eval-state` directory and the supplied
`--state-dir` inside agent Bash sandboxes with empty read-only mounts. Controller
memory access remains available. Other host directories are still readable under
the workspace-write sandbox; this is not a full filesystem allowlist. This masking
was added after the initial `real-v3-basic-20261111-080239` run and does not apply
retroactively to that run. Claude Code does not use this Bash executor.
