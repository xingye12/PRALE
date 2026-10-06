# Cross-repository execution evidence protocol

This protocol supplements `evals/experience-crossrepo-v1/TASKSET.md`. It changes
benchmark evidence collection only; harness storage, recovery, and domain APIs
are unaffected.

## ADR-001: Controller replay instead of task-specific executable oracles

Background: structural acceptance checks citations and artifact shape, but does
not verify executable delivery. Agent-authored success notes cannot establish
that a test/demo/operation ran. Building bespoke behavioral oracles for every
task is outside the current scope.

Decision: non-explore stages submit complete executable files and local fixtures,
and a relative-workspace Bash command in `validation.command`. After the agent
and structural oracle finish, the controller snapshots the submitted workspace
and replays the command in a separate copy with fresh HOME/TMPDIR, no copied
agent memory, pipefail, and a controller-selected timeout (default 60 seconds).
The existing host-execution opt-in and pinned-container policy also apply to
replay; copying a directory does not enforce network or filesystem isolation.
Commands must not depend on the old absolute workspace path. Retry-safe local
fixtures are required because the agent should execute before submission too.

The controller writes full stdout/stderr directly to files outside the replay
workspace, records command, status, exit code, duration and hashes, and stops
the process group on timeout and completion. It preserves `.prale-eval` replay
artifacts separately from the original submission. Missing commands, launch
failures and timeouts are explicit states, never fabricated successful output.

The archive adds `execution/execution.json`, `stdout.txt`, `stderr.txt`, and
`artifacts/`; `manifest.json` hashes execution metadata. The stage report adds an
`execution` projection. Structural acceptance remains separate and unchanged.
Existing stage duration excludes controller replay so agent wall-time comparisons
retain their meaning; replay duration is recorded separately in execution metadata.

The LLM judge receives complete archived code/delivery, workspace diff, cited
sources, captured streams and replay artifacts. It verifies capture hashes and
does not silently truncate files. Context overflow fails scoring rather than
scoring incomplete evidence. It judges objective coverage and meaningful checks,
not merely zero exit status. Expected negative-path exits may be valid. For
non-explore tasks without completed replay, validation credit is zero and
quality cannot pass. Historical archives remain readable but cannot acquire
execution credit retroactively. Exploration remains eligible without replay.

Consequences: this supplies independent execution evidence without 30 separate
behavioral oracles. It does not prove mutation sensitivity or semantic correctness;
the LLM still evaluates assertion quality and whether behavior meets the objective.
Use a new run/state directory: previous reports and archived submissions are not
rewritten. Original files/diff describe the submission before replay, and replay
outputs cannot replace those files.

Verification covers full separate output streams, nonzero exits, missing commands,
timeout cleanup, original submission preservation, replay artifact retention,
archive integration, judge inputs and execution-credit gating.
